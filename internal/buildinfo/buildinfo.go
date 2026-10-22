// Package buildinfo exposes version information injected at build time:
//
//	go build -ldflags "-X github.com/RafalPolawski/SyncMusic/internal/buildinfo.Version=v1.2.3 ..."
package buildinfo

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

// Set via -ldflags.
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

func init() {
	if Commit != "" {
		return
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				Commit = s.Value
			case "vcs.time":
				if Date == "" {
					Date = s.Value
				}
			}
		}
	}
}

// String returns a human readable version line.
func String() string {
	commit := Commit
	if len(commit) > 12 {
		commit = commit[:12]
	}
	s := "syncmusic " + Version
	if commit != "" {
		s += " (" + commit + ")"
	}
	if Date != "" {
		s += " built " + Date
	}
	return fmt.Sprintf("%s %s/%s %s", s, runtime.GOOS, runtime.GOARCH, runtime.Version())
}
