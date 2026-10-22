// Package media wraps ffprobe and ffmpeg: reading audio metadata and
// transcoding files into small, phone friendly formats.
package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Info describes an audio file.
type Info struct {
	Format     string // container name reported by ffprobe, e.g. "flac", "mp3", "ogg"
	Codec      string // codec of the first audio stream
	DurationMs int64
	Bitrate    int // bits per second (stream bitrate, falls back to container bitrate)
	SampleRate int
	Channels   int
	HasCover   bool // an embedded picture is present

	Title       string
	Artist      string
	Album       string
	AlbumArtist string
	Genre       string
	Year        int
	TrackNo     int
	DiscNo      int
}

// Prober extracts metadata from audio files.
type Prober interface {
	Probe(ctx context.Context, path string) (Info, error)
}

// ErrNoAudio is returned for files without an audio stream.
var ErrNoAudio = errors.New("no audio stream")

// FFprobe implements Prober with the ffprobe binary.
type FFprobe struct {
	FFprobePath string
	// FFmpegPath is used to measure exact durations when ffprobe can only
	// estimate them (e.g. VBR MP3 files without a Xing header).
	FFmpegPath string
	Timeout    time.Duration
}

type ffprobeOutput struct {
	Streams []struct {
		CodecType   string            `json:"codec_type"`
		CodecName   string            `json:"codec_name"`
		SampleRate  string            `json:"sample_rate"`
		Channels    int               `json:"channels"`
		BitRate     string            `json:"bit_rate"`
		Duration    string            `json:"duration"`
		Tags        map[string]string `json:"tags"`
		Disposition map[string]int    `json:"disposition"`
	} `json:"streams"`
	Format struct {
		FormatName string            `json:"format_name"`
		Duration   string            `json:"duration"`
		BitRate    string            `json:"bit_rate"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
}

const estimatedDurationWarning = "Estimating duration from bitrate"

// Probe runs ffprobe on path.
func (p FFprobe) Probe(ctx context.Context, path string) (Info, error) {
	timeout := p.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	bin := p.FFprobePath
	if bin == "" {
		bin = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, bin, "-v", "warning", "-hide_banner",
		"-print_format", "json", "-show_format", "-show_streams", "--", path)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return Info{}, fmt.Errorf("ffprobe %s: %w: %s", path, err, firstLine(stderr.String()))
	}
	info, err := parseFFprobe(stdout.Bytes())
	if err != nil {
		return Info{}, fmt.Errorf("ffprobe %s: %w", path, err)
	}
	if strings.Contains(stderr.String(), estimatedDurationWarning) || info.DurationMs <= 0 {
		if d, err := p.measureDuration(ctx, path); err == nil && d > 0 {
			info.DurationMs = d
		}
	}
	return info, nil
}

// measureDuration remuxes the audio stream to a null sink (no decoding) and
// reads the final timestamp, which is exact even for header-less VBR MP3.
func (p FFprobe) measureDuration(ctx context.Context, path string) (int64, error) {
	bin := p.FFmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, bin, "-nostdin", "-v", "error", "-i", path,
		"-map", "0:a:0", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return 0, err
	}
	return parseProgressDuration(stdout.Bytes()), nil
}

func parseProgressDuration(b []byte) int64 {
	var last int64
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		// out_time_us is the modern key; out_time_ms historically also holds microseconds.
		if k == "out_time_us" || k == "out_time_ms" {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && n > 0 {
				last = n / 1000
			}
		}
	}
	return last
}

func parseFFprobe(b []byte) (Info, error) {
	var out ffprobeOutput
	if err := json.Unmarshal(b, &out); err != nil {
		return Info{}, err
	}
	var info Info
	info.Format = out.Format.FormatName
	found := false
	tags := map[string]string{}
	mergeTags(tags, out.Format.Tags)
	for _, s := range out.Streams {
		switch s.CodecType {
		case "audio":
			if found {
				continue
			}
			found = true
			info.Codec = s.CodecName
			info.SampleRate, _ = strconv.Atoi(s.SampleRate)
			info.Channels = s.Channels
			info.Bitrate, _ = strconv.Atoi(s.BitRate)
			if d := parseSeconds(s.Duration); d > 0 {
				info.DurationMs = d
			}
			// Ogg/Opus files keep their tags on the stream, not the container.
			mergeTags(tags, s.Tags)
		case "video":
			if s.Disposition["attached_pic"] == 1 {
				info.HasCover = true
			}
		}
	}
	if !found {
		return Info{}, ErrNoAudio
	}
	if d := parseSeconds(out.Format.Duration); d > 0 && (info.DurationMs == 0 || strings.Contains(info.Format, "mp3")) {
		info.DurationMs = d
	}
	if info.Bitrate == 0 {
		info.Bitrate, _ = strconv.Atoi(out.Format.BitRate)
	}
	info.Title = tags["title"]
	info.Artist = firstNonEmpty(tags["artist"], tags["album_artist"], tags["albumartist"])
	info.Album = tags["album"]
	info.AlbumArtist = firstNonEmpty(tags["album_artist"], tags["albumartist"])
	info.Genre = tags["genre"]
	info.Year = parseYear(firstNonEmpty(tags["date"], tags["year"], tags["originaldate"]))
	info.TrackNo = parseIndex(firstNonEmpty(tags["track"], tags["tracknumber"]))
	info.DiscNo = parseIndex(firstNonEmpty(tags["disc"], tags["discnumber"]))
	return info, nil
}

func mergeTags(dst, src map[string]string) {
	for k, v := range src {
		k = strings.ToLower(k)
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, exists := dst[k]; !exists {
			dst[k] = v
		}
	}
}

func parseSeconds(s string) int64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0
	}
	return int64(math.Round(f * 1000))
}

// parseIndex handles "3", "03" and "3/12".
func parseIndex(s string) int {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "/")
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// parseYear handles "2019", "2019-05-01" and "2019/05".
func parseYear(s string) int {
	s = strings.TrimSpace(s)
	if len(s) < 4 {
		return 0
	}
	n, err := strconv.Atoi(s[:4])
	if err != nil || n < 1000 || n > 9999 {
		return 0
	}
	return n
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
