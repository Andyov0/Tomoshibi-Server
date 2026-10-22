package app

import "runtime/debug"

// buildID is the commit this binary was built from, or empty.
//
// Read from the module's build information rather than passed in from main,
// because main's own version string carries a date and a "modified" mark that
// would make two builds of one commit look different to a page comparing them.
// Empty outside a repository, which a page reads as "do not compare": a
// development server should not tell anybody to reload.
var buildID = func() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}

	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			return setting.Value
		}
	}

	return ""
}()
