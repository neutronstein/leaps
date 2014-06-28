/*
Copyright (c) 2014 Ashley Jeffs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

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

package leaplib

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"sync"
	"testing"
	"time"
)

func TestNewBinder(t *testing.T) {
	errChan := make(chan BinderError)
	doc, err := CreateNewDocument("test", "test1", "text", "hello world")
	if err != nil {
		t.Errorf("error: %v", err)
		return
	}

	logConf := DefaultLoggerConfig()
	logConf.LogLevel = LeapError

	logger := CreateLogger(logConf)

	binder, err := BindNew(doc, &MemoryStore{documents: map[string]*Document{}}, DefaultBinderConfig(), errChan, logger)
	if err != nil {
		t.Errorf("error: %v", err)
		return
	}

	go func() {
		for err := range errChan {
			t.Errorf("From error channel: %v", err.Err)
		}
	}()

	portal1, portal2 := binder.Subscribe(), binder.Subscribe()
	if v, err := portal1.SendTransform(
		OTransform{
			Position: 6,
			Version:  2,
			Delete:   5,
			Insert:   "universe",
		},
		time.Second,
	); v != 2 || err != nil {
		t.Errorf("Send Transform error, v: %v, err: %v", v, err)
	}

	tforms1 := <-portal1.TransformRcvChan
	tforms2 := <-portal2.TransformRcvChan

	if len1, len2 := len(tforms1), len(tforms2); len1 != 1 || len2 != 1 {
		t.Errorf("Wrong count of transforms, tforms1: %v, tforms2: %v", len1, len2)
	}

	portal3 := binder.Subscribe()
	if exp, rec := "hello universe", portal3.Document.Content.(string); exp != rec {
		t.Errorf("Wrong content, expected %v, received %v", exp, rec)
	}
}

func badClient(b *BinderPortal, t *testing.T, wg *sync.WaitGroup) {
	// Do nothing, LOLOLOLOLOL AHAHAHAHAHAHAHAHAHA! TIME WASTTTTIIINNNGGGG!!!!
	time.Sleep(100 * time.Millisecond)

	// The first transform is free (buffered chan)
	<-b.TransformRcvChan
	_, open := <-b.TransformRcvChan
	if open {
		t.Errorf("Bad client wasn't rejected")
	}
	wg.Done()
}

func goodClient(b *BinderPortal, expecting int, t *testing.T, wg *sync.WaitGroup) {
	changes := b.Version + 1
	seen := 0
	for change := range b.TransformRcvChan {
		seen++
		for _, tformWrap := range change {
			tform, ok := tformWrap.(OTransform)
			if !ok {
				t.Errorf("did not receive expected OTransform")
			} else if tform.Insert != fmt.Sprintf("%v", changes) {
				t.Errorf("Wrong order of transforms, expected %v, received %v",
					changes, tform.Insert)
			}
			changes++
		}
	}
	if seen != expecting {
		t.Errorf("Good client didn't receive all expected transforms: %v != %v", expecting, seen)
	}
	wg.Done()
}

func TestClients(t *testing.T) {
	errChan := make(chan BinderError)
	config := DefaultBinderConfig()
	config.FlushPeriod = 5000

	logConf := DefaultLoggerConfig()
	logConf.LogLevel = LeapError

	logger := CreateLogger(logConf)

	wg := sync.WaitGroup{}

	doc, err := CreateNewDocument("test", "test1", "text", "hello world")
	if err != nil {
		t.Errorf("error: %v", err)
		return
	}

	binder, err := BindNew(doc, &MemoryStore{documents: map[string]*Document{}}, DefaultBinderConfig(), errChan, logger)
	if err != nil {
		t.Errorf("error: %v", err)
		return
	}

	go func() {
		for err := range errChan {
			t.Errorf("From error channel: %v", err.Err)
		}
	}()

	tform := func(i int) OTransform {
		return OTransform{
			Position: 0,
			Version:  i,
			Delete:   0,
			Insert:   fmt.Sprintf("%v", i),
		}
	}

	portal := binder.Subscribe()

	if v, err := portal.SendTransform(tform(portal.Version+1), time.Second); v != 2 || err != nil {
		t.Errorf("Send Transform error, v: %v, err: %v", v, err)
	}

	wg.Add(20)
	tformToSend := 50

	for i := 0; i < 10; i++ {
		go goodClient(binder.Subscribe(), tformToSend, t, &wg)
		go badClient(binder.Subscribe(), t, &wg)
	}

	wg.Add(tformToSend)

	for i := 0; i < tformToSend; i++ {
		if i%2 == 0 {
			go goodClient(binder.Subscribe(), tformToSend-i, t, &wg)
			go badClient(binder.Subscribe(), t, &wg)
		}
		if v, err := portal.SendTransform(tform(i+3), time.Second); v != i+3 || err != nil {
			t.Errorf("Send Transform error, expected v: %v, got v: %v, err: %v", i+3, v, err)
		}
	}

	binder.Close()

	wg.Wait()
}

type binderStory struct {
	Content    string       `json:"content"`
	Transforms []OTransform `json:"transforms"`
	TCorrected []OTransform `json:"corrected_transforms"`
	Result     string       `json:"result"`
}

type binderStoriesContainer struct {
	Stories []binderStory `json:"binder_stories"`
}

func goodStoryClient(b *BinderPortal, bstory *binderStory, wg *sync.WaitGroup, t *testing.T) {
	tformIndex, lenCorrected := 0, len(bstory.TCorrected)
	go func() {
		for ret := range b.TransformRcvChan {
			for _, tformWrap := range ret {
				tform, ok := tformWrap.(OTransform)
				if !ok {
					t.Errorf("did not receive expected OTransform")
				} else if tform.Version != bstory.TCorrected[tformIndex].Version ||
					tform.Insert != bstory.TCorrected[tformIndex].Insert ||
					tform.Delete != bstory.TCorrected[tformIndex].Delete ||
					tform.Position != bstory.TCorrected[tformIndex].Position {
					t.Errorf("Transform not expected, %v != %v", tform, bstory.TCorrected[tformIndex])
				}
				tformIndex++
				if tformIndex == lenCorrected {
					wg.Done()
					return
				}
			}
		}
		t.Errorf("channel was closed before receiving last change")
		wg.Done()
		return
	}()
}

func TestBinderStories(t *testing.T) {
	nClients := 10

	logConf := DefaultLoggerConfig()
	logConf.LogLevel = LeapError

	logger := CreateLogger(logConf)

	bytes, err := ioutil.ReadFile("../data/binder_stories.js")
	if err != nil {
		t.Errorf("Read file error: %v", err)
		return
	}

	var scont binderStoriesContainer
	if err := json.Unmarshal(bytes, &scont); err != nil {
		t.Errorf("Story parse error: %v", err)
		return
	}

	for i, story := range scont.Stories {
		doc, err := CreateNewDocument(fmt.Sprintf("story%v", i), "testing", "text", story.Content)
		if err != nil {
			t.Errorf("error: %v", err)
			continue
		}

		config := DefaultBinderConfig()
		//config.LogVerbose = true

		errChan := make(chan BinderError)
		go func() {
			for err := range errChan {
				t.Errorf("From error channel: %v", err.Err)
			}
		}()

		binder, err := BindNew(doc, &MemoryStore{documents: map[string]*Document{}}, config, errChan, logger)
		if err != nil {
			t.Errorf("error: %v", err)
			continue
		}

		wg := sync.WaitGroup{}
		wg.Add(nClients)

		for j := 0; j < nClients; j++ {
			goodStoryClient(binder.Subscribe(), &story, &wg, t)
		}

		time.Sleep(10 * time.Millisecond)

		bp := binder.Subscribe()
		go func() {
			for _ = range bp.TransformRcvChan {
			}
		}()

		for j := 0; j < len(story.Transforms); j++ {
			if _, err = bp.SendTransform(story.Transforms[j], time.Second); err != nil {
				t.Errorf("Send issue %v", err)
			}
		}

		wg.Wait()

		newClient := binder.Subscribe()
		if got, exp := newClient.Document.Content.(string), story.Result; got != exp {
			t.Errorf("Wrong result, expected: %v, received: %v", exp, got)
		}

		binder.Close()
	}
}