package media

import (
	"path/filepath"
	"strings"
)

// Format is an output audio format requested by a client.
type Format string

// Quality is a requested output quality level.
type Quality string

const (
	FormatOpus Format = "opus" // Ogg Opus: best quality per bit, supported by Android/Chrome/Firefox
	FormatAAC  Format = "aac"  // AAC in MP4: universally supported (incl. iOS)

	QualityLow      Quality = "low"
	QualityMedium   Quality = "medium"
	QualityHigh     Quality = "high"
	QualityOriginal Quality = "original"
)

// Profile is a concrete transcoding target.
type Profile struct {
	Name    string // stable cache key component, e.g. "opus-96"
	Format  Format
	Bitrate int // bits per second
	Ext     string
	MIME    string
}

var profiles = map[Format]map[Quality]Profile{
	FormatOpus: {
		QualityLow:    {Name: "opus-64", Format: FormatOpus, Bitrate: 64_000, Ext: ".ogg", MIME: "audio/ogg"},
		QualityMedium: {Name: "opus-96", Format: FormatOpus, Bitrate: 96_000, Ext: ".ogg", MIME: "audio/ogg"},
		QualityHigh:   {Name: "opus-160", Format: FormatOpus, Bitrate: 160_000, Ext: ".ogg", MIME: "audio/ogg"},
	},
	FormatAAC: {
		QualityLow:    {Name: "aac-96", Format: FormatAAC, Bitrate: 96_000, Ext: ".m4a", MIME: "audio/mp4"},
		QualityMedium: {Name: "aac-128", Format: FormatAAC, Bitrate: 128_000, Ext: ".m4a", MIME: "audio/mp4"},
		QualityHigh:   {Name: "aac-192", Format: FormatAAC, Bitrate: 192_000, Ext: ".m4a", MIME: "audio/mp4"},
	},
}

// ParseFormat normalises a format query value; unknown values fall back to Opus.
func ParseFormat(s string) Format {
	switch Format(strings.ToLower(s)) {
	case FormatAAC:
		return FormatAAC
	default:
		return FormatOpus
	}
}

// ParseQuality normalises a quality query value; unknown values fall back to medium.
func ParseQuality(s string) Quality {
	switch q := Quality(strings.ToLower(s)); q {
	case QualityLow, QualityMedium, QualityHigh, QualityOriginal:
		return q
	default:
		return QualityMedium
	}
}

// LookupProfile returns the profile for a format/quality pair. Original
// quality has no profile.
func LookupProfile(f Format, q Quality) (Profile, bool) {
	p, ok := profiles[f][q]
	return p, ok
}

// Source is the minimal description of an input file needed to decide
// whether and how to transcode it.
type Source struct {
	TrackID  string
	Path     string // absolute path
	Size     int64
	MtimeNs  int64
	Codec    string
	Bitrate  int
	Channels int
}

var lossyCodecs = map[string]bool{"mp3": true, "aac": true, "opus": true, "vorbis": true}

// playableEverywhere lists source codecs every supported browser can play
// directly, so a small enough lossy file never needs re-encoding.
var playableEverywhere = map[string]bool{"mp3": true, "aac": true}

// Plan decides how a file is delivered: either the original bytes or a
// transcoded profile. Re-encoding an already small lossy file only loses
// quality, so such files are passed through when the client can play them.
func Plan(src Source, f Format, q Quality, transcodeEnabled bool) (Profile, bool) {
	if !transcodeEnabled || q == QualityOriginal {
		return Profile{}, false
	}
	p, ok := LookupProfile(f, q)
	if !ok {
		return Profile{}, false
	}
	codec := strings.ToLower(src.Codec)
	if lossyCodecs[codec] && src.Bitrate > 0 && src.Bitrate <= p.Bitrate*3/2 {
		playable := playableEverywhere[codec] || (f == FormatOpus && (codec == "opus" || codec == "vorbis"))
		if playable {
			return Profile{}, false
		}
	}
	return p, true
}

var mimeByExt = map[string]string{
	".mp3":  "audio/mpeg",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
	".m4a":  "audio/mp4",
	".m4b":  "audio/mp4",
	".mp4":  "audio/mp4",
	".aac":  "audio/aac",
	".wav":  "audio/wav",
	".aif":  "audio/aiff",
	".aiff": "audio/aiff",
	".wma":  "audio/x-ms-wma",
	".wv":   "audio/wavpack",
	".ape":  "audio/x-ape",
	".mka":  "audio/x-matroska",
	".webm": "audio/webm",
}

// AudioExtensions are the file extensions recognised as audio during scans.
var AudioExtensions = func() map[string]bool {
	m := make(map[string]bool, len(mimeByExt))
	for ext := range mimeByExt {
		m[ext] = true
	}
	return m
}()

// MIMEType returns the content type for an audio file name.
func MIMEType(name string) string {
	if m, ok := mimeByExt[strings.ToLower(filepath.Ext(name))]; ok {
		return m
	}
	return "application/octet-stream"
}
