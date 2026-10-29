package library

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // register decoders for embedded and folder images
	"os"
	"path/filepath"
	"strconv"

	"github.com/dhowden/tag"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/singleflight"
)

// ErrNoCover is returned when a track has neither embedded art nor a folder image.
var ErrNoCover = errors.New("no cover art")

// Covers extracts, downsizes and caches album art. Phones on a weak network
// should never download a 5 MB PNG just to show a 56px thumbnail.
type Covers struct {
	lib   *Library
	dir   string
	group singleflight.Group
}

// NewCovers creates a cover service caching resized images in dir.
func NewCovers(lib *Library, dir string) (*Covers, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create cover cache: %w", err)
	}
	return &Covers{lib: lib, dir: dir}, nil
}

// CoverSizes are the allowed output sizes (square bounding box, pixels).
var CoverSizes = []int{128, 512}

// NormalizeSize picks the smallest allowed size >= requested.
func NormalizeSize(requested int) int {
	for _, s := range CoverSizes {
		if requested <= s {
			return s
		}
	}
	return CoverSizes[len(CoverSizes)-1]
}

// Path returns the path of a cached JPEG cover for a track, creating it on
// first use. The returned key changes when the source changes.
func (c *Covers) Path(trackID string, size int) (string, error) {
	snap := c.lib.Snapshot()
	t, ok := snap.Track(trackID)
	if !ok {
		return "", ErrNoCover
	}
	size = NormalizeSize(size)
	folderImage := snap.FolderImage(t.Folder)
	if !t.HasCover && folderImage == "" {
		return "", ErrNoCover
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d\x00%s\x00%d", t.Path, t.Size, t.MtimeNs, folderImage, size)
	if folderImage != "" {
		if fi, err := os.Stat(folderImage); err == nil {
			fmt.Fprintf(h, "\x00%d\x00%d", fi.Size(), fi.ModTime().UnixNano())
		}
	}
	name := trackID + "-" + strconv.Itoa(size) + "-" + hex.EncodeToString(h.Sum(nil))[:12] + ".jpg"
	out := filepath.Join(c.dir, name)
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	v, err, _ := c.group.Do(name, func() (any, error) {
		if _, err := os.Stat(out); err == nil {
			return out, nil
		}
		var data []byte
		if t.HasCover {
			if abs, err := c.lib.AbsPath(t.Path); err == nil {
				data, _ = embeddedPicture(abs)
			}
		}
		if data == nil && folderImage != "" {
			data, _ = os.ReadFile(folderImage)
		}
		if data == nil {
			return "", ErrNoCover
		}
		jpg, err := resizeToJPEG(data, size)
		if err != nil {
			return "", err
		}
		tmp := out + ".tmp"
		if err := os.WriteFile(tmp, jpg, 0o644); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, out); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
		return out, nil
	})
	if err != nil {
		return "", err
	}
	return v.(string), nil
}

func embeddedPicture(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	m, err := tag.ReadFrom(f)
	if err != nil {
		return nil, err
	}
	if p := m.Picture(); p != nil && len(p.Data) > 0 {
		return p.Data, nil
	}
	return nil, ErrNoCover
}

// resizeToJPEG scales an image to fit in a size x size box (never upscaling)
// and encodes it as JPEG.
func resizeToJPEG(data []byte, size int) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode cover: %w", err)
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return nil, errors.New("empty cover image")
	}
	scale := min(float64(size)/float64(w), float64(size)/float64(h), 1)
	dw, dh := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
