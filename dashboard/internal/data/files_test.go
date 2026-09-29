package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListGeneratedFilesFindsMarkdownInGeneratedDirs(t *testing.T) {
	tempDir := t.TempDir()
	for _, dir := range []string{"interview-prep", "reports", "output"} {
		if err := os.MkdirAll(filepath.Join(tempDir, dir), 0o755); err != nil {
			t.Fatalf("failed to create %s: %v", dir, err)
		}
	}

	files := map[string]string{
		"interview-prep/finastra-hr-call.md": "# Finastra - Intro HR Call Brief\n\nBody",
		"reports/001-acme.md":                "# Evaluation: Acme\n\nBody",
		"output/outreach.md":                 "# Outreach Draft\n\nBody",
		"output/cv.docx":                     "not markdown",
	}
	for rel, content := range files {
		if err := os.WriteFile(filepath.Join(tempDir, rel), []byte(content), 0o644); err != nil {
			t.Fatalf("failed to write %s: %v", rel, err)
		}
	}

	got := ListGeneratedFiles(tempDir)
	if len(got) != 3 {
		t.Fatalf("expected 3 markdown files, got %d: %+v", len(got), got)
	}

	byPath := map[string]string{}
	for _, file := range got {
		byPath[file.RelPath] = file.Title
	}
	if byPath[filepath.Join("interview-prep", "finastra-hr-call.md")] != "Finastra - Intro HR Call Brief" {
		t.Fatalf("expected heading title for interview prep file, got %q", byPath[filepath.Join("interview-prep", "finastra-hr-call.md")])
	}
	if _, ok := byPath[filepath.Join("output", "cv.docx")]; ok {
		t.Fatal("expected non-markdown files to be skipped")
	}
}
