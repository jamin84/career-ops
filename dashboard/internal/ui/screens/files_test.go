package screens

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func TestFilesSearchFiltersByTitlePathAndCategory(t *testing.T) {
	files := []model.GeneratedFile{
		{Title: "Finastra HR Call", RelPath: "interview-prep/finastra-hr-call.md", Category: "Prep"},
		{Title: "Capacity Report", RelPath: "reports/065-capacity.md", Category: "Report"},
		{Title: "Outreach Draft", RelPath: "output/outreach.md", Category: "Output"},
	}

	m := NewFilesModel(theme.NewTheme("catppuccin-mocha"), files, 140, 30)

	m.searchQuery = "finastra"
	m.applyFilter()
	if len(m.filtered) != 1 || m.filtered[0].Title != "Finastra HR Call" {
		t.Fatalf("expected title/path search to match Finastra file, got %+v", m.filtered)
	}

	m.searchQuery = "report"
	m.applyFilter()
	if len(m.filtered) != 1 || m.filtered[0].Category != "Report" {
		t.Fatalf("expected category search to match report file, got %+v", m.filtered)
	}
}

func TestFilesEnterOpensCurrentFile(t *testing.T) {
	files := []model.GeneratedFile{
		{Title: "Finastra HR Call", Path: "/tmp/finastra.md", RelPath: "interview-prep/finastra.md", Category: "Prep"},
	}

	m := NewFilesModel(theme.NewTheme("catppuccin-mocha"), files, 140, 30)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("expected Enter to emit open command")
	}
	msg := cmd()
	open, ok := msg.(FilesOpenMsg)
	if !ok {
		t.Fatalf("expected FilesOpenMsg, got %T", msg)
	}
	if open.Path != "/tmp/finastra.md" || open.Title != "Finastra HR Call" {
		t.Fatalf("unexpected open msg: %+v", open)
	}
}

func TestFilesViewShowsHelpAndRows(t *testing.T) {
	files := []model.GeneratedFile{
		{Title: "Finastra HR Call", RelPath: "interview-prep/finastra.md", Category: "Prep", Modified: "2026-07-07 09:00"},
	}

	m := NewFilesModel(theme.NewTheme("catppuccin-mocha"), files, 140, 30)
	view := m.View()
	plain := ansi.Strip(view)

	for _, want := range []string{"GENERATED FILES", "Finastra HR Call", "interview-prep/finastra.md", "Enter", "search"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected view to contain %q, got %q", want, plain)
		}
	}
}
