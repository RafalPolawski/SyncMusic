package library

import (
	"bufio"
	"bytes"
	"net/url"
	"path"
	"strings"
)

// parseM3U extracts entries from an .m3u/.m3u8 playlist. Relative entries are
// resolved to library-relative paths (playlistRel is the playlist's own
// relative path); absolute entries are returned as-is for suffix matching.
// Entries escaping the library and remote URLs are ignored.
func parseM3U(data []byte, playlistRel string) []string {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")) // UTF-8 BOM
	base := path.Dir(NormalizePath(playlistRel))
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "file://") {
			u, err := url.Parse(line)
			if err != nil {
				continue
			}
			line = u.Path
		} else if strings.Contains(line, "://") {
			continue // remote stream
		}
		entry := NormalizePath(line)
		if path.IsAbs(entry) || (len(entry) > 1 && entry[1] == ':') {
			// Absolute paths from another machine are resolved later by
			// matching their tail against library paths.
			out = append(out, entry)
			continue
		}
		rel := path.Clean(path.Join(base, entry))
		if rel == ".." || strings.HasPrefix(rel, "../") {
			continue
		}
		out = append(out, rel)
	}
	return out
}

// playlistName derives a display name from the playlist file name.
func playlistName(rel string) string {
	b := path.Base(rel)
	return strings.TrimSuffix(b, path.Ext(b))
}
