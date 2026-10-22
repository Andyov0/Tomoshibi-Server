package dns

import "testing"

/*
Whether a name resolves to the address it was pointed at.

The zone accepting a record and the internet returning it are two different
statements, and everything that separates them is quiet: a CNAME above the name
shadowing it, the subtree served by somebody else, a conflicting record
somewhere with higher precedence. Each of those ends the same way — an API call
that succeeded, a log line saying the name was created, and a machine nobody can
reach by it.

This is what asks. It is deliberately not clever: no resolver of its own, no
retry, no opinion about TTLs. It answers the one question, and the caller
decides what to do about the answer.
*/

func TestAnswersComparesTheAddressAndNotJustThatSomethingResolved(t *testing.T) {
	// A name that resolves, to something that is not the address asked about.
	// Nothing about "it resolved" means "it resolved to us", and that
	// difference is the whole reason this exists.
	ok, err := Answers("localhost", "203.0.113.9")
	if err != nil {
		t.Skipf("no resolver here: %v", err)
	}

	if ok {
		t.Error("said a name answers to an address it does not: a check that returns true " +
			"for any resolvable name reports success for exactly the case it was written " +
			"to catch")
	}
}

func TestAnswersFindsTheAddressWhenItIsThere(t *testing.T) {
	ok, err := Answers("localhost", "127.0.0.1")
	if err != nil {
		t.Skipf("no resolver here: %v", err)
	}

	if !ok {
		t.Error("localhost does not answer to 127.0.0.1, which means this would report every " +
			"correctly created record as broken")
	}
}

func TestANameThatDoesNotResolveIsAnErrorRatherThanAFalseNo(t *testing.T) {
	// Told apart on purpose. "The name is not there" and "the name is there and
	// points elsewhere" want different sentences from whoever reads the log:
	// one is a record that was never created, the other is one that lost.
	if _, err := Answers("no-such-host.invalid", "203.0.113.9"); err == nil {
		t.Error("a name that does not resolve came back as a plain no, which reads in a log " +
			"as a record pointing at the wrong place rather than as no record at all")
	}
}
