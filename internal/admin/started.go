package admin

import "time"

// Started is when this process came up, for a page that wants to say how long
// it has been up.
//
// A package variable initialised at load, rather than a field set in a
// constructor, because the two things that read it are on opposite sides of the
// deployment: the management pages here, and a relay's own counters, which are
// served by a handler that never builds an API at all. Threading a start time
// from main into both is a parameter that exists only to be passed along.
//
// It lived beside the deployment checks until those were removed. They reported
// on a media server, and on a control node — which holds no calls — there was
// none to report on: the endpoint answered with a fleet reading instead, a
// different shape entirely, and the page that expected a list of checks read a
// map as an array and took the whole management interface down with it. What the
// checks were for is now asked of each relay and shown against it, which is
// where the answer was always going to be.
var Started = time.Now()
