package library

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// TrackID derives a stable identifier from a library-relative path.
func TrackID(relPath string) string {
	sum := sha256.Sum256([]byte("track:" + NormalizePath(relPath)))
	return hex.EncodeToString(sum[:8])
}

// PlaylistID derives a stable identifier for an .m3u file.
func PlaylistID(relPath string) string {
	sum := sha256.Sum256([]byte("playlist:" + NormalizePath(relPath)))
	return hex.EncodeToString(sum[:8])
}

// NormalizePath converts a path to forward slashes and Unicode NFC, so the
// same file gets the same id whether it was scanned on Linux or macOS.
func NormalizePath(p string) string {
	return norm.NFC.String(strings.ReplaceAll(p, "\\", "/"))
}

var leadingNumber = regexp.MustCompile(`^\s*\d{1,3}\s*([.\-_)]\s*|\s+)`)

// guessFromFilename derives a title (and possibly an artist) from a file name
// such as "03 - Artist - Title.mp3" when the file carries no tags.
func guessFromFilename(relPath string) (title, artist string) {
	base := path.Base(relPath)
	name := strings.TrimSuffix(base, path.Ext(base))
	name = strings.TrimSpace(strings.ReplaceAll(name, "_", " "))
	if stripped := leadingNumber.ReplaceAllString(name, ""); stripped != "" {
		name = stripped
	}
	if a, t, ok := strings.Cut(name, " - "); ok && strings.TrimSpace(a) != "" && strings.TrimSpace(t) != "" {
		return strings.TrimSpace(t), strings.TrimSpace(a)
	}
	if name == "" {
		name = base
	}
	return name, ""
}

// naturalLess compares strings case-insensitively, treating digit runs as
// numbers so "Track 2" sorts before "Track 10".
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		if isDigit(a[0]) && isDigit(b[0]) {
			na, restA := splitDigits(a)
			nb, restB := splitDigits(b)
			ta, tb := strings.TrimLeft(na, "0"), strings.TrimLeft(nb, "0")
			if len(ta) != len(tb) {
				return len(ta) < len(tb)
			}
			if ta != tb {
				return ta < tb
			}
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			a, b = restA, restB
			continue
		}
		ra, sa := utf8.DecodeRuneInString(a)
		rb, sb := utf8.DecodeRuneInString(b)
		if ra != rb {
			return ra < rb
		}
		a, b = a[sa:], b[sb:]
	}
	return len(a) < len(b)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func splitDigits(s string) (digits, rest string) {
	i := 0
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	return s[:i], s[i:]
}

// skipDir reports directories that are never part of a music library
// (hidden folders, NAS metadata, recycle bins).
func skipDir(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	switch strings.ToLower(name) {
	case "@eadir", "#recycle", "$recycle.bin", "lost+found", "system volume information", "#snapshot":
		return true
	}
	return false
}

var folderImageNames = []string{"cover", "folder", "front", "album", "albumart"}

// isFolderImage reports file names conventionally used for album art.
func isFolderImage(name string) bool {
	lower := strings.ToLower(name)
	ext := path.Ext(lower)
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp":
	default:
		return false
	}
	base := strings.TrimSuffix(lower, ext)
	for _, n := range folderImageNames {
		if base == n {
			return true
		}
	}
	return false
}

// folderImageRank orders candidate images; lower is better.
func folderImageRank(name string) int {
	base := strings.TrimSuffix(strings.ToLower(name), path.Ext(name))
	for i, n := range folderImageNames {
		if base == n {
			return i
		}
	}
	return len(folderImageNames)
}
