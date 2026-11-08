package app

import "testing"

/*
What the management pages are told the apps are offered at.

The answer has to be the one the download page and the apps' update check are
given, not a reading of the manifest's own newest line: a build whose file is
the wrong size or does not hash to what the manifest says is not offered to
anybody, and a page that called it the current version would send an operator
looking for an update nobody is receiving.
*/
func TestTheAdminShelfIsWhatIsOffered(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac": {{version: "1.2.0", file: "Tomoshibi-1.2.0.dmg", contents: []byte("mac 1.2.0")}},
		// Still being copied in: the size is not what the manifest says, so
		// it is not offered to anybody yet, and the page must not say it is.
		"windows": {{version: "1.3.0", file: "Tomoshibi-Setup-1.3.0.exe", contents: []byte("win 1.3"), size: 999}},
	})

	offered, configured := adminShelf{desk: desk(t, nil, dir)}.Offered()
	if !configured {
		t.Fatal("a directory was configured and the shelf said none was")
	}

	by := map[string]bool{}
	for _, one := range offered {
		by[one.Platform] = one.Available

		if one.Platform == "mac" && one.Version != "1.2.0" {
			t.Errorf("the Mac app is offered at %q, want 1.2.0", one.Version)
		}
	}

	for _, platform := range []string{"mac", "android", "windows", "ios", "linux-x86_64", "linux-aarch64"} {
		if _, listed := by[platform]; !listed {
			t.Errorf("the shelf does not list %s at all", platform)
		}
	}

	if !by["mac"] || by["android"] || by["windows"] || by["ios"] || by["linux-x86_64"] || by["linux-aarch64"] {
		t.Errorf("available: %v, want the Mac app alone, and not the Windows build whose file does not check", by)
	}

	if _, configured := (adminShelf{}).Offered(); configured {
		t.Error("no directory, and the shelf said one was configured")
	}
}
