package main

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dhowden/tag"
	_ "modernc.org/sqlite"
)

var db *sql.DB
var dbMutex sync.Mutex

type ScanStatus struct {
	IsScanning  bool `json:"is_scanning"`
	ScanCurrent int  `json:"scan_current"`
	ScanTotal   int  `json:"scan_total"`
}

var (
	scanProgressMutex sync.Mutex
	currentScanStatus ScanStatus
)

func GetScanStatus() ScanStatus {
	scanProgressMutex.Lock()
	defer scanProgressMutex.Unlock()
	return currentScanStatus
}

func initDB() {
	var err error
	db, err = sql.Open("sqlite", "syncmusic.db")
	if err != nil {
		log.Fatalf("[ERROR] Failed to open database: %v", err)
	}

	createTableQuery := `
	CREATE TABLE IF NOT EXISTS songs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT UNIQUE,
		title TEXT,
		artist TEXT,
		folder TEXT,
		size INTEGER DEFAULT 0
	);`

	_, err = db.Exec(createTableQuery)
	if err != nil {
		log.Fatalf("[ERROR] Failed to create table: %v", err)
	}

	// Ensure size column exists for older DBs
	db.Exec("ALTER TABLE songs ADD COLUMN size INTEGER DEFAULT 0")

	log.Println("[INFO] Database initialized successfully.")
}

func scanLibraryToDB() {
	log.Println("[INFO] Starting library scan to database...")

	scanProgressMutex.Lock()
	currentScanStatus = ScanStatus{IsScanning: true, ScanCurrent: 0, ScanTotal: 0}
	scanProgressMutex.Unlock()

	defer func() {
		scanProgressMutex.Lock()
		currentScanStatus.IsScanning = false
		scanProgressMutex.Unlock()
	}()

	// Invalidate cover art cache so rescan picks up new/changed artwork
	coverCacheMutex.Lock()
	coverCache = make(map[string]*cachedCover)
	coverCacheKeys = nil
	coverCacheMutex.Unlock()

	// Clear existing tracks (rebuild is fast enough with SQLite)
	dbMutex.Lock()
	_, err := db.Exec("DELETE FROM songs")
	dbMutex.Unlock()

	if err != nil {
		log.Printf("[ERROR] Failed to clear DB before rescan: %v\n", err)
		return
	}

	var paths []string
	err = filepath.Walk("./music", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		validExts := map[string]bool{
			".opus": true, ".mp3": true, ".flac": true,
			".wav": true, ".ogg": true, ".m4a": true, ".aac": true,
		}
		if !info.IsDir() && validExts[ext] {
			paths = append(paths, path)
		}
		return nil
	})

	if err != nil {
		log.Printf("[ERROR] Failed to walk music directory: %v\n", err)
		return
	}

	scanProgressMutex.Lock()
	currentScanStatus.ScanTotal = len(paths)
	scanProgressMutex.Unlock()

	var wg sync.WaitGroup
	var resultsMutex sync.Mutex
	semaphore := make(chan struct{}, 20)

	type SongRecord struct {
		Path   string
		Title  string
		Artist string
		Folder string
		Size   int64
	}
	var records []SongRecord

	for _, p := range paths {
		wg.Add(1)
		semaphore <- struct{}{}

		go func(path string) {
			defer wg.Done()
			defer func() { <-semaphore }()

			relPath, _ := filepath.Rel("music", path)
			relPath = filepath.ToSlash(relPath)

			parts := strings.Split(relPath, "/")
			folder := "Loose Tracks"
			if len(parts) > 1 {
				folder = parts[0]
			}

			f, fsErr := os.Open(path)
			if fsErr != nil {
				return
			}
			defer f.Close()

			var fileSize int64
			if stat, err := f.Stat(); err == nil {
				fileSize = stat.Size()
			}

			fileName := filepath.Base(path)
			ext := filepath.Ext(path)
			title := fileName // fallback
			artist := "Unknown Artist"

			m, tagErr := tag.ReadFrom(f)
			if tagErr == nil && m != nil {
				if m.Title() != "" {
					title = m.Title()
				} else {
					title = title[:len(title)-len(ext)]
				}
				if m.Artist() != "" {
					artist = m.Artist()
				}
			} else {
				title = title[:len(title)-len(ext)]
			}

			resultsMutex.Lock()
			records = append(records, SongRecord{
				Path:   relPath,
				Title:  title,
				Artist: artist,
				Folder: folder,
				Size:   fileSize,
			})
			resultsMutex.Unlock()

			scanProgressMutex.Lock()
			currentScanStatus.ScanCurrent++
			scanProgressMutex.Unlock()
		}(p)
	}

	wg.Wait()

	// Only hold dbMutex for the transaction itself, not the entire parallel scan
	dbMutex.Lock()
	defer dbMutex.Unlock()

	tx, err := db.Begin()
	if err != nil {
		log.Printf("[ERROR] Failed to start DB transaction: %v\n", err)
		return
	}

	stmt, err := tx.Prepare("INSERT INTO songs (path, title, artist, folder, size) VALUES (?, ?, ?, ?, ?)")
	if err != nil {
		log.Printf("[ERROR] Failed to prepare statement: %v\n", err)
		tx.Rollback()
		return
	}
	defer stmt.Close()

	for _, r := range records {
		_, err = stmt.Exec(r.Path, r.Title, r.Artist, r.Folder, r.Size)
		if err != nil {
			log.Printf("[WARN] Failed to insert song %s: %v\n", r.Path, err)
		}
	}

	err = tx.Commit()
	if err != nil {
		log.Printf("[ERROR] Failed to commit DB transaction: %v\n", err)
	} else {
		log.Printf("[INFO] Library scan complete. %d tracks inserted into database.\n", len(records))
	}
}

func getSongsFromDB() ([]SongMeta, error) {
	dbMutex.Lock()
	defer dbMutex.Unlock()

	rows, err := db.Query("SELECT path, title, artist, size FROM songs ORDER BY folder, title")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var songs []SongMeta
	for rows.Next() {
		var s SongMeta
		if err := rows.Scan(&s.Path, &s.Title, &s.Artist, &s.Size); err != nil {
			continue
		}
		songs = append(songs, s)
	}

	if err = rows.Err(); err != nil {
		return nil, err
	}
	return songs, nil
}
