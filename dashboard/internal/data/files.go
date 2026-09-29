package data

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var generatedFileDirs = []struct {
	dir      string
	category string
}{
	{"interview-prep", "Prep"},
	{"reports", "Report"},
	{"output", "Output"},
}

// ListGeneratedFiles returns local markdown documents that are useful to read
// from the dashboard. It intentionally stays in user-data/generated folders.
func ListGeneratedFiles(careerOpsPath string) []model.GeneratedFile {
	var files []model.GeneratedFile

	for _, source := range generatedFileDirs {
		root := filepath.Join(careerOpsPath, source.dir)
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || filepath.Ext(entry.Name()) != ".md" {
				continue
			}
			path := filepath.Join(root, entry.Name())
			info, err := entry.Info()
			if err != nil {
				continue
			}
			rel, err := filepath.Rel(careerOpsPath, path)
			if err != nil {
				rel = filepath.Join(source.dir, entry.Name())
			}

			files = append(files, model.GeneratedFile{
				Title:    markdownTitle(path, entry.Name()),
				Path:     path,
				RelPath:  rel,
				Category: source.category,
				Modified: info.ModTime().Format("2006-01-02 15:04"),
				Size:     info.Size(),
			})
		}
	}

	sort.SliceStable(files, func(i, j int) bool {
		ti := parseGeneratedModified(files[i].Modified)
		tj := parseGeneratedModified(files[j].Modified)
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return files[i].RelPath < files[j].RelPath
	})

	return files
}

func markdownTitle(path, fallback string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return strings.TrimSuffix(fallback, filepath.Ext(fallback))
	}
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		}
	}
	return strings.TrimSuffix(fallback, filepath.Ext(fallback))
}

func parseGeneratedModified(value string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", value, time.Local)
	if err != nil {
		return time.Time{}
	}
	return t
}
