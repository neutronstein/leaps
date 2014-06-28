/*
Copyright (c) 2014 Ashley Jeffs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, sub to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

/*--------------------------------------------------------------------------------------------------
 */

/* _leap_model is an object designed to keep track of the inbound and outgoing transforms
 * for a local document, and updates the caller with the appropriate actions at each stage.
 *
 * _leap_model has three states:
 * 1. READY     - No pending sends, transforms received can be applied instantly to local document.
 * 2. SENDING   - Transforms are being sent and we're awaiting the corrected version of those
 *                transforms.
 * 3. BUFFERING - A corrected version has been received for our latest send but we're still waiting
 *                for the transforms that came before that send to be received before moving on.
 */
var _leap_model = function(base_version) {
	"use strict";

	this.READY = 1;
	this.SENDING = 2;
	this.BUFFERING = 3;

	this._leap_state = this.READY;

	this._corrected_version = 0;
	this._version = base_version;

	this._unapplied = [];
	this._unsent = [];
	this._sending = null;
};

/* _validate_transforms iterates an array of transform objects and validates that each transform
 * contains the correct fields. Returns an error message as a string if there was a problem.
 */
_leap_model.prototype._validate_transforms = function(transforms) {
	"use strict";

	for ( var i = 0, l = transforms.length; i < l; i++ ) {
		var tform = transforms[i];

		if ( typeof(tform.position) !== "number" ) {
			tform.position = parseInt(tform.position);
			if ( isNaN(tform.position) ) {
				return "transform contained NaN value for position: " + JSON.stringify(tform);
			}
		}
		if ( tform.num_delete !== undefined && typeof(tform.num_delete) !== "number" ) {
			tform.num_delete = parseInt(tform.num_delete);
			if ( isNaN(tform.num_delete) ) {
				return "transform contained NaN value for num_delete: " + JSON.stringify(tform);
			}
		}
		if ( tform.version !== undefined && typeof(tform.version) !== "number" ) {
			tform.version = parseInt(tform.version);
			if ( isNaN(tform.version) ) {
				return "transform contained NaN value for version: " + JSON.stringify(tform);
			}
		}
		if ( tform.insert !== undefined ) {
			if ( typeof(tform.insert) !== "string" ) {
				return "transform contained non-string value for insert: " + JSON.stringify(tform);
			}
		} else {
			tform.insert = "";
		}
	};
};

/* merge_transforms takes two transforms (the next to be sent, and the one that follows) and
 * attempts to merge them into one transform. This will not be possible with some combinations, and
 * the function returns a boolean to indicate whether the merge was successful.
 */
_leap_model.prototype._merge_transforms = function(first, second) {
	if ( first.position + first.insert.length === second.position ) {
		first.insert = first.insert + second.insert;
		first.num_delete += second.num_delete;
		return true;
	}
	if ( second.position === first.position ) {
		var remainder = Math.max(0, second.num_delete - first.insert.length);
		first.num_delete += remainder;
		first.insert = second.insert + first.insert.slice(second.num_delete);
		return true;
	}
	if ( second.position > first.position && second.position < ( first.position + first.insert.length ) ) {
		var overlap = second.position - first.position;
		var remainder = Math.max(0, second.num_delete - (first.insert.length - overlap));
		first.num_delete += remainder;
		first.insert = first.insert.slice(0, overlap) + second.insert
			+ first.insert.slice(overlap + second.num_delete);
		return true;
	}
	return false;
};

/* collide_transforms takes an unapplied transform from the server, and an unsent transform from the
 * client and modifies both transforms.
 *
 * The unapplied transform is fixed so that when applied to the local document is unaffected by the
 * unsent transform that has already been applied. The unsent transform is fixed so that it is
 * unaffected by the unapplied transform when submitted to the server.
 */
_leap_model.prototype._collide_transforms = function(unapplied, unsent) {
	"use strict";

	var earlier, later;

	if ( unapplied.position <= unsent.position ) {
		earlier = unapplied;
		later = unsent;
	} else {
		earlier = unsent;
		later = unapplied;
	}

	if ( earlier.num_delete === 0 ) {
		later.position += earlier.insert.length;
	} else if ( ( earlier.num_delete + earlier.position ) <= later.position ) {
		later.position += ( earlier.insert.length - earlier.num_delete );
	} else {
		var pos_gap = later.position - earlier.position;
		var over_hang = Math.min(later.insert.length, earlier.num_delete - pos_gap);
		var excess = Math.max(0, (earlier.num_delete - pos_gap));

		// earlier changes
		if ( excess > later.num_delete ) {
			earlier.num_delete += later.insert.length - later.num_delete;
			earlier.insert = earlier.insert + later.insert;
		} else {
			earlier.num_delete = pos_gap;
		}

		// later changes
		later.num_delete = Math.min(0, later.num_delete - excess);
		later.position = earlier.position + earlier.insert.length;
	}
};

/*--------------------------------------------------------------------------------------------------
 */

/* _resolve_state will prompt the leap_model to re-evalutate its current state for validity. If this
 * state is determined to no longer be appropriate then it will return an object containing the
 * following actions to be performed.
 */
_leap_model.prototype._resolve_state = function() {
	"use strict";

	switch (this._leap_state) {
	case this.READY:
	case this.SENDING:
		return {};
	case this.BUFFERING:
		if ( ( this._version + this._unapplied.length ) >= (this._corrected_version - 1) ) {

			this._version += this._unapplied.length + 1;

			var to_collide = [ this._sending ].concat(this._unsent);
			var unapplied = this._unapplied;

			this._unapplied = [];

			for ( var i = 0, li = unapplied.length; i < li; i++ ) {
				for ( var j = 0, lj = to_collide.length; j < lj; j++ ) {
					this._collide_transforms(unapplied[i], to_collide[j]);
				}
			}

			this._sending = null;

			if ( this._unsent.length > 0 ) {
				this._sending = this._unsent.shift();
				while ( this._unsent.length > 0 && this._merge_transforms(this._sending, this._unsent[0]) ) {
					this._unsent.shift();
				}

				this._sending.version = this._version + 1;

				this._leap_state = this.SENDING;
				return { send : this._sending, apply : unapplied };
			} else {
				this._leap_state = this.READY;
				return { apply : unapplied };
			}
		}
	}
	return {}
};

/* correct is the function to call following a "correction" from the server, this correction value
 * gives the model the information it needs to determine which changes are missing from our model
 * from before our submission was accepted.
 */
_leap_model.prototype.correct = function(version) {
	"use strict";

	switch (this._leap_state) {
	case this.READY:
	case this.BUFFERING:
		return { error : "received unexpected correct action" };
	case this.SENDING:
		this._leap_state = this.BUFFERING;
		this._corrected_version = version;

		return this._resolve_state();
	}

	return {};
};

/* submit is the function to call when we wish to submit more local changes to the server. The model
 * will determine whether it is currently safe to dispatch those changes to the server, and will
 * also provide each change with the correct version number.
 */
_leap_model.prototype.submit = function(transform) {
	"use strict";

	switch (this._leap_state) {
	case this.READY:
		this._leap_state = this.SENDING;
		transform.version = this._version + 1;

		this._sending = transform;
		return { send : transform };
	case this.BUFFERING:
	case this.SENDING:
		this._unsent = this._unsent.concat(transform);
	}

	return {};
};

/* receive is the function to call when we have received transforms from our server. If we have
 * recently dispatched transforms and have yet to receive our correction then it is unsafe to apply
 * these changes to our local document, so the model will keep return these transforms to us when it
 * is known to be safe.
 */
_leap_model.prototype.receive = function(transforms) {
	"use strict";

	switch (this._leap_state) {
	case this.READY:
		this._version += transforms.length;
		return { apply : transforms };
	case this.BUFFERING:
		this._unapplied = this._unapplied.concat(transforms);
		return this._resolve_state();
	case this.SENDING:
		this._unapplied = this._unapplied.concat(transforms);
	}

	return {};
};

/*--------------------------------------------------------------------------------------------------
 */

/* leap_client is the main tool provided to allow an easy and stable interface for connecting to a
 * leaps server.
 */
var leap_client = function() {
	"use strict";

	this._socket = null;
	this._document_id = null;

	this._model = null;

	this._events = {};
};

/* subscribe_event, attach a function to an event of the leap_client. Use this to subscribe to
 * transforms, document responses and errors etc. Returns a string if an error occurrs.
 */
leap_client.prototype.subscribe_event = function(name, subscriber) {
	if ( typeof(subscriber) !== "function" ) {
		return "subscriber was not a function";
	}
	var targets = this._events[name];
	if ( targets !== undefined && targets instanceof Array ) {
		targets.push(subscriber);
	} else {
		this._events[name] = [ subscriber ];
	}
};

/* clear_subscribers, removes all functions subscribed to an event.
 */
leap_client.prototype.clear_subscribers = function(name) {
	this._events[name] = [];
};

/* dispatch_event, sends args to all subscribers of an event.
 */
leap_client.prototype._dispatch_event = function(name, args) {
	var targets = this._events[name];
	if ( targets !== undefined && targets instanceof Array ) {
		for ( var i = 0, l = targets.length; i < l; i++ ) {
			if (typeof(targets[i]) === "function") {
				targets[i].apply(this, args);
			}
		}
	}
};

/* _do_action is a call that acts accordingly provided an action_obj from our leap_model.
 */
leap_client.prototype._do_action = function(action_obj) {
	"use strict";

	if ( action_obj.error !== undefined ) {
		return action_obj.error;
	}
	if ( action_obj.apply !== undefined && action_obj.apply instanceof Array ) {
		this._dispatch_event("on_transforms", [ action_obj.apply ]);
	}
	if ( action_obj.send !== undefined && action_obj.send instanceof Object ) {
		this._socket.send(JSON.stringify({
			command : "submit",
			transform : action_obj.send
		}));
	}
};

/* _process_message is a call that takes a server provided message object and decides the
 * appropriate action to take. If an error occurs during this process then an error message is
 * returned.
 */
leap_client.prototype._process_message = function(message) {
	"use strict";

	if ( message.response_type === undefined
	  || typeof(message.response_type) !== "string" ) {
		return "message received did not contain a valid type";
	}

	switch (message.response_type) {
	case "document":
		if ( null === message.leap_document
		  || "object" !== typeof(message.leap_document)
		  || "string" !== typeof(message.leap_document.id)
		  || "string" !== typeof(message.leap_document.title)
		  || "string" !== typeof(message.leap_document.description)
		  || "string" !== typeof(message.leap_document.type)
		  || "string" !== typeof(message.leap_document.content) ) {
			return "message document type contained invalid document object";
		}
		if ( !(message.version > 0) ) {
			return "message document received but without valid version";
		}
		if ( this._document_id !== null && this._document_id !== message.leap_document.id ) {
			return "received unexpected document, id was mismatched: "
				+ this._document_id + " != " + message.leap_document.id;
		}
		this.document_id = message.leap_document.id;
		this._model = new _leap_model(message.version);
		this._dispatch_event("on_document", [ message.leap_document ]);
		break;
	case "transforms":
		if ( this._model === null ) {
			return "transforms were received before initialization";
		}
		if ( !(message.transforms instanceof Array) ) {
			return "received non array transforms";
		}
		var validate_error = this._model._validate_transforms(message.transforms);
		if ( validate_error !== undefined ) {
			return "received transforms with error: " + validate_error;
		}
		var action_obj = this._model.receive(message.transforms);
		var action_err = this._do_action(action_obj);
		if ( action_err !== undefined ) {
			return "failed to receive transforms: " + action_err;
		}
		break;
	case "correction":
		if ( this._model === null ) {
			return "correction was received before initialization";
		}
		if ( typeof(message.version) !== "number" ) {
			message.version = parseInt(message.version);
			if ( isNaN(message.version) ) {
				return "correction received was NaN";
			}
		}
		var action_obj = this._model.correct(message.version);
		var action_err = this._do_action(action_obj);
		if ( action_err !== undefined ) {
			return "model failed to correct: " + action_err;
		}
		break;
	case "error":
		if ( this._socket !== null ) {
			this._socket.close();
		}
		if ( typeof(message.error) === "string" ) {
			return message.error;
		}
		return "server sent undeterminable error";
		break;
	default:
		return "message received was not a recognised type"
	}
};

/* send_transform is the function to call to send a transform off to the server. To keep the local
 * document responsive this transform should be applied to the document straight away. The
 * leap_client will decide when it is appropriate to dispatch the transform, and will manage
 * internally how incoming messages should be altered to account for the fact that the local
 * change was made out of order.
 */
leap_client.prototype.send_transform = function(transform) {
	"use strict";

	if ( this._model === null ) {
		return "leap_client must be initialized and joined to a document before submitting transforms"
	}

	var validate_error = this._model._validate_transforms([ transform ]);
	if ( validate_error !== undefined ) {
		return validate_error;
	}

	var action_obj = this._model.submit(transform);
	var action_err = this._do_action(action_obj);
	if ( action_err !== undefined ) {
		return "model failed to submit: " + action_err;
	}
};

/* join_document prompts the client to request to join a document from the server. It will return an
 * error message if there is a problem with the request.
 */
leap_client.prototype.join_document = function(id) {
	"use strict";

	if ( this._socket === null || this._socket.readyState !== 1 ) {
		return "leap_client is not currently connected";
	}

	if ( typeof(id) !== "string" ) {
		return "document id was not a string type";
	}

	if ( this._document_id !== null ) {
		return "a leap_client can only join a single document";
	}

	this._document_id = id;

	this._socket.send(JSON.stringify({
		command : "find",
		document_id : this._document_id
	}));
};

/* create_document will inform the server that a new document should be created with a title,
 * description, and initial content, the client will submit any valid string values for these
 * fields, but it is up to the leaps server to determine whether those values match its own
 * requirements.
 */
leap_client.prototype.create_document = function(title, description, content) {
	"use strict";

	if ( this._socket === null || this._socket.readyState !== 1 ) {
		return "leap_client is not currently connected";
	}

	if ( typeof(title) !== "string" ) {
		return "new document requires a valid title";
	}
	if ( typeof(description) !== "string" ) {
		return "new document requires a valid description (can be empty)";
	}
	if ( typeof(content) !== "string" ) {
		return "new document requires valid content (can be empty)";
	}

	if ( this._document_id !== null ) {
		return "a leap_client can only join a single document";
	}

	this._socket.send(JSON.stringify({
		command : "create",
		leap_document : {
			title       : title,
			description : description,
			type        : "text",
			content     : content
		}
	}));
};

/* connect is the first interaction that should occur with the leap_client after defining your event
 * bindings. This function will generate a websocket connection with the server, ready to bind to a
 * document.
 */
leap_client.prototype.connect = function(address, _websocket) {
	"use strict";

	try {
		if ( _websocket !== undefined ) {
				this._socket = _websocket;
		} else if ( window.WebSocket !== undefined ) {
				this._socket = new WebSocket(address);
		} else {
			return "no websocket support in this browser";
		}
	} catch(e) {
		return "socket connection failed: " + e.message;
	}

	var leap_obj = this;

	this._socket.onmessage = function(e) {
		var message_text = e.data;
		var message_obj;

		try {
			message_obj = JSON.parse(message_text);
		} catch (e) {
			leap_obj._dispatch_event.apply(leap_obj,
				[ "on_error", [ JSON.stringify(e.message) + " (" + e.lineNumber + "): " + message_text ] ]);
			return;
		}

		var err = leap_obj._process_message.apply(leap_obj, [ message_obj ]);
		if ( typeof(err) === "string" ) {
			leap_obj._dispatch_event.apply(leap_obj, [ "on_error", [ err ] ]);
		}
	};

	this._socket.onclose = function() {
		leap_obj._dispatch_event.apply(leap_obj, [ "on_disconnect", [] ]);
	};

	this._socket.onopen = function() {
		leap_obj._dispatch_event.apply(leap_obj, [ "on_connect", arguments ]);
	};

	this._socket.onerror = function() {
		leap_obj._dispatch_event.apply(leap_obj, [ "on_error", arguments ]);
	};
};

/*--------------------------------------------------------------------------------------------------
 */

/* leap_apply is a function that applies a single transform to content and returns the result.
 */
var leap_apply = function(transform, content) {
	var first = content.slice(0, transform.position);
	var second = content.slice(transform.position + transform.num_delete, content.length);

	return first + transform.insert + second;
};

leap_client.prototype.apply = leap_apply;

/*--------------------------------------------------------------------------------------------------
 */

try {
	if ( module !== undefined && typeof(module) === "object" ) {
		module.exports = {
			client : leap_client,
			apply : leap_apply,
			_model : _leap_model
		};
	}
} catch(e) {
}

/*--------------------------------------------------------------------------------------------------
 */