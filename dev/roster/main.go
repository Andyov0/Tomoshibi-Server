// Add or remove an administrator where the list actually lives.
//
// The configuration file is only read when the store holds none, so editing it
// on a deployment that already has an administrator changes nothing at all —
// no error, no warning, and a sign-in that answers 401. This writes to the
// store. The service has to be stopped first, because bolt admits one writer.
package main

import (
	"fmt"
	"os"

	"tomoshibi/internal/store"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: roster <db> list")
		fmt.Println("       roster <db> add <trip> [name] [observe|moderate]")
		fmt.Println("       roster <db> drop <trip>")
		os.Exit(2)
	}

	path, action := os.Args[1], os.Args[2]

	kept, err := store.Open(path)
	if err != nil {
		fmt.Println("open:", err)
		os.Exit(1)
	}
	defer kept.Close()

	switch action {
	case "add":
		// Both capabilities unless asked for one, because the reason to reach
		// for this is being locked out and somebody locked out needs to be able
		// to act. But "observe" has to be reachable: a monitor signs in to read
		// the fleet and nothing more, and giving it the ability to close every
		// meeting on the deployment because that was the only option here is a
		// credential on a cron job that can end every call.
		admin := store.Admin{Trip: os.Args[3], Can: []string{"observe", "moderate"}}
		if len(os.Args) > 4 {
			admin.Name = os.Args[4]
		}
		if len(os.Args) > 5 {
			switch os.Args[5] {
			case "observe":
				admin.Can = []string{"observe"}
			case "moderate":
				admin.Can = []string{"observe", "moderate"}
			default:
				fmt.Printf("%q is not something an administrator can be allowed. "+
					"The two are \"observe\" and \"moderate\"\n", os.Args[5])
				os.Exit(2)
			}
		}

		if err := kept.AddAdmin(admin); err != nil {
			fmt.Println("add:", err)
			os.Exit(1)
		}

	case "drop":
		if err := kept.RemoveAdmin(os.Args[3]); err != nil {
			fmt.Println("drop:", err)
			os.Exit(1)
		}

	case "list":

	default:
		fmt.Println("unknown action", action)
		os.Exit(2)
	}

	list, err := kept.Admins()
	if err != nil {
		fmt.Println("list:", err)
		os.Exit(1)
	}

	for _, one := range list {
		fmt.Printf("  %s  %-12s %v\n", one.Trip, one.Name, one.Can)
	}
}
