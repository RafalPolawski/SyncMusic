// Package testutil generates real audio fixtures with ffmpeg for tests.
package testutil

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// Spec describes a generated audio file.
type Spec struct {
	Path     string  // relative path inside the target directory; extension selects the codec
	Seconds  float64 // duration (default 2)
	Freq     int     // sine frequency (default 440)
	Title    string
	Artist   string
	Album    string
	Track    string
	Cover    bool // embed a small PNG picture
	Channels int  // default 2
}

// RequireFFmpeg skips the test when ffmpeg/ffprobe are unavailable, unless
// SYNCMUSIC_REQUIRE_FFMPEG=1 is set (CI), in which case it fails.
func RequireFFmpeg(t testing.TB) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			if os.Getenv("SYNCMUSIC_REQUIRE_FFMPEG") == "1" {
				t.Fatalf("%s not found in PATH", bin)
			}
			t.Skipf("%s not found in PATH", bin)
		}
	}
}

// Generate writes the described files below dir and returns their absolute paths.
func Generate(t testing.TB, dir string, specs ...Spec) []string {
	t.Helper()
	RequireFFmpeg(t)
	var out []string
	var cover string
	for _, s := range specs {
		if s.Cover && cover == "" {
			cover = filepath.Join(t.TempDir(), "cover.png")
			run(t, "-f", "lavfi", "-i", "color=c=0x22aa66:s=96x96", "-frames:v", "1", cover)
		}
		out = append(out, generateOne(t, dir, s, cover))
	}
	return out
}

func generateOne(t testing.TB, dir string, s Spec, cover string) string {
	t.Helper()
	if s.Seconds == 0 {
		s.Seconds = 2
	}
	if s.Freq == 0 {
		s.Freq = 440
	}
	if s.Channels == 0 {
		s.Channels = 2
	}
	path := filepath.Join(dir, filepath.FromSlash(s.Path))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	src := fmt.Sprintf("sine=frequency=%d:duration=%s:sample_rate=44100", s.Freq, strconv.FormatFloat(s.Seconds, 'f', 3, 64))
	args := []string{"-f", "lavfi", "-i", src}
	withCover := s.Cover && cover != ""
	if withCover {
		args = append(args, "-i", cover)
	}
	args = append(args, "-map", "0:a")
	if withCover {
		args = append(args, "-map", "1:v", "-c:v", "png", "-disposition:v", "attached_pic")
	}
	args = append(args, "-ac", strconv.Itoa(s.Channels))
	for k, v := range map[string]string{"title": s.Title, "artist": s.Artist, "album": s.Album, "track": s.Track} {
		if v != "" {
			args = append(args, "-metadata", k+"="+v)
		}
	}
	switch filepath.Ext(path) {
	case ".mp3":
		args = append(args, "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3")
	case ".flac":
		args = append(args, "-c:a", "flac")
	case ".ogg", ".opus":
		args = append(args, "-c:a", "libopus", "-b:a", "64k", "-f", "ogg")
	case ".m4a":
		args = append(args, "-c:a", "aac", "-b:a", "128k")
	case ".wav":
		args = append(args, "-c:a", "pcm_s16le")
	}
	args = append(args, path)
	run(t, args...)
	return path
}

func run(t testing.TB, args ...string) {
	t.Helper()
	full := append([]string{"-nostdin", "-hide_banner", "-v", "error", "-y"}, args...)
	cmd := exec.CommandContext(context.Background(), "ffmpeg", full...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, stderr.String())
	}
}
