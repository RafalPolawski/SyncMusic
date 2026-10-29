// Command syncmusic is a self-hosted server for listening to music together,
// perfectly in sync, on any number of phones.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/RafalPolawski/SyncMusic/internal/app"
	"github.com/RafalPolawski/SyncMusic/internal/buildinfo"
	"github.com/RafalPolawski/SyncMusic/internal/config"
	"github.com/RafalPolawski/SyncMusic/internal/webui"
)

const usage = `Usage: syncmusic [command]

Commands:
  serve        run the server (default)
  healthcheck  exit 0 if the local server answers /healthz (for container health checks)
  version      print version information

Configuration is read from SYNCMUSIC_* environment variables; see README.md.
`

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		os.Exit(serve())
	case "healthcheck":
		os.Exit(healthcheck())
	case "version", "--version", "-v":
		fmt.Println(buildinfo.String())
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
}

func serve() int {
	cfg, err := config.Load(nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration error:", err)
		return 2
	}
	log := app.NewLogger(cfg, os.Stderr)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := app.Run(ctx, cfg, log, app.Options{WebFS: webui.FS()}); err != nil {
		log.Error("fatal", "err", err)
		return 1
	}
	return 0
}

func healthcheck() int {
	cfg, err := config.Load(nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	addr := cfg.Listen
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/healthz", http.NoBody)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unhealthy:", err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "unhealthy: status", resp.StatusCode)
		return 1
	}
	return 0
}
