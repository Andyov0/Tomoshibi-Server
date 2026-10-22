//go:build ascstub

package testflight

import (
	"log/slog"
	"os"
)

// A build for trying the invitation form against a stand-in, never a release.
//
// Built with `go build -tags ascstub`, the binary sends its App Store Connect
// requests to TOMOSHIBI_ASC_STUB instead of to Apple, which is what lets the
// whole path — the page, the handler, the token and the 409 dance — be run on a
// laptop against dev/ascstub without a real key or a real tester. It is a build
// tag rather than a setting so that no configuration file, and no environment
// a deployment happens to inherit, can make a release build hand its signed
// token to something that is not Apple. Said at startup every time, so a binary
// built this way cannot be mistaken for one that is not.
func init() {
	if stub := os.Getenv("TOMOSHIBI_ASC_STUB"); stub != "" {
		base = stub
		slog.Warn("App Store Connect requests go to a stand-in; this binary was built "+
			"with the ascstub tag and must not be deployed", "url", stub)
	}
}
