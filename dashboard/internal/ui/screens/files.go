package screens

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// FilesClosedMsg is emitted when the generated-files screen is dismissed.
type FilesClosedMsg struct{}

// FilesOpenMsg is emitted when a generated file should open in the viewer.
type FilesOpenMsg struct {
	Path  string
	Title string
}

// FilesRefreshMsg requests a fresh scan of generated files.
type FilesRefreshMsg struct{}

// FilesModel implements a generated markdown file browser.
type FilesModel struct {
	files        []model.GeneratedFile
	filtered     []model.GeneratedFile
	cursor       int
	scrollOffset int
	width        int
	height       int
	theme        theme.Theme
	searchInput  bool
	searchQuery  string
}

// NewFilesModel creates a generated-files browser.
func NewFilesModel(t theme.Theme, files []model.GeneratedFile, width, height int) FilesModel {
	m := FilesModel{
		files:  files,
		width:  width,
		height: height,
		theme:  t,
	}
	m.applyFilter()
	return m
}

// WithReloadedData rebuilds the file list while preserving search and selection.
func (m FilesModel) WithReloadedData(files []model.GeneratedFile) FilesModel {
	selected := ""
	if file, ok := m.CurrentFile(); ok {
		selected = file.RelPath
	}

	reloaded := NewFilesModel(m.theme, files, m.width, m.height)
	reloaded.searchInput = m.searchInput
	reloaded.searchQuery = m.searchQuery
	reloaded.applyFilter()

	for i, file := range reloaded.filtered {
		if file.RelPath == selected {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
	}
	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}
	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.adjustScroll()
	return reloaded
}

// CurrentFile returns the selected generated file, if any.
func (m FilesModel) CurrentFile() (model.GeneratedFile, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.GeneratedFile{}, false
	}
	return m.filtered[m.cursor], true
}

// Init implements tea.Model.
func (m FilesModel) Init() tea.Cmd {
	return nil
}

// Resize updates dimensions.
func (m *FilesModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.adjustScroll()
}

// Width returns the current width.
func (m FilesModel) Width() int { return m.width }

// Height returns the current height.
func (m FilesModel) Height() int { return m.height }

// Update handles input for the generated-files screen.
func (m FilesModel) Update(msg tea.Msg) (FilesModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.searchInput {
			return m.handleSearchInput(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.adjustScroll()
	}
	return m, nil
}

func (m FilesModel) handleKey(msg tea.KeyMsg) (FilesModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		if m.searchQuery != "" && msg.String() == "esc" {
			m.searchQuery = ""
			m.applyFilter()
			m.cursor = 0
			m.scrollOffset = 0
			return m, nil
		}
		return m, func() tea.Msg { return FilesClosedMsg{} }

	case "/":
		m.searchInput = true
		return m, nil

	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}

	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}

	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			m.cursor += max(1, m.bodyHeight()/2)
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}

	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			m.cursor -= max(1, m.bodyHeight()/2)
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}

	case "g", "home":
		m.cursor = 0
		m.scrollOffset = 0

	case "G", "end":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
		}

	case "r":
		return m, func() tea.Msg { return FilesRefreshMsg{} }

	case "enter":
		if file, ok := m.CurrentFile(); ok {
			return m, func() tea.Msg {
				return FilesOpenMsg{Path: file.Path, Title: file.Title}
			}
		}
	}
	return m, nil
}

func (m FilesModel) handleSearchInput(msg tea.KeyMsg) (FilesModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.searchInput = false
		m.searchQuery = ""
		m.applyFilter()
		m.cursor = 0
		m.scrollOffset = 0
		return m, nil

	case "enter":
		m.searchInput = false
		return m, nil

	case "backspace":
		if len(m.searchQuery) > 0 {
			runes := []rune(m.searchQuery)
			m.searchQuery = string(runes[:len(runes)-1])
			m.applyFilter()
			m.cursor = 0
			m.scrollOffset = 0
		}
		return m, nil

	case "ctrl+u":
		m.searchQuery = ""
		m.applyFilter()
		m.cursor = 0
		m.scrollOffset = 0
		return m, nil
	}

	if r := msg.Runes; len(r) > 0 {
		m.searchQuery += strings.ToLower(string(r))
		m.applyFilter()
		m.cursor = 0
		m.scrollOffset = 0
	}
	return m, nil
}

func (m *FilesModel) applyFilter() {
	var filtered []model.GeneratedFile
	for _, file := range m.files {
		if generatedFileMatches(file, m.searchQuery) {
			filtered = append(filtered, file)
		}
	}
	m.filtered = filtered
	if m.cursor >= len(m.filtered) {
		m.cursor = len(m.filtered) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	m.adjustScroll()
}

func generatedFileMatches(file model.GeneratedFile, query string) bool {
	if query == "" {
		return true
	}
	q := strings.ToLower(query)
	haystack := strings.ToLower(strings.Join([]string{
		file.Title,
		file.RelPath,
		file.Category,
	}, " "))
	return strings.Contains(haystack, q)
}

func (m FilesModel) bodyHeight() int {
	h := m.height - m.chromeRows()
	if h < 3 {
		h = 3
	}
	return h
}

func (m FilesModel) chromeRows() int {
	rows := 5 // header + column header + help + spacing
	if m.searchInput || m.searchQuery != "" {
		rows++
	}
	return rows
}

func (m *FilesModel) adjustScroll() {
	availHeight := m.bodyHeight()
	margin := 2
	if m.cursor >= m.scrollOffset+availHeight-margin {
		m.scrollOffset = m.cursor - availHeight + margin + 1
	}
	if m.cursor < m.scrollOffset+margin {
		m.scrollOffset = m.cursor - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
	maxScroll := len(m.filtered) - availHeight
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		m.scrollOffset = maxScroll
	}
}

// View renders the generated-files screen.
func (m FilesModel) View() string {
	sections := []string{m.renderHeader()}
	if search := m.renderSearchBar(); search != "" {
		sections = append(sections, search)
	}
	sections = append(sections, m.renderColumnHeader(), m.renderBody(), m.renderHelp())
	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}

func (m FilesModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render("GENERATED FILES")
	info := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(
		fmt.Sprintf("%d files | %d shown", len(m.files), len(m.filtered)),
	)

	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m FilesModel) renderSearchBar() string {
	if !m.searchInput && m.searchQuery == "" {
		return ""
	}
	style := lipgloss.NewStyle().
		Foreground(m.theme.Text).
		Width(m.width).
		Padding(0, 2)

	prompt := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("/")
	display := lipgloss.NewStyle().Foreground(m.theme.Text).Render(m.searchQuery)
	if m.searchInput {
		display += lipgloss.NewStyle().Foreground(m.theme.Blue).Render("█")
	}

	hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	hint := hintStyle.Render("   Enter: keep   Esc: clear   Ctrl+U: clear")
	return style.Render(prompt + " " + display + hint)
}

type fileColWidths struct {
	category, modified, path, title int
}

func (m FilesModel) columnWidths() fileColWidths {
	c := fileColWidths{category: 12, modified: 16}
	if m.width >= 112 {
		c.path = 32
	} else {
		c.path = 24
	}
	fixed := c.category + c.modified + c.path
	c.title = m.width - fixed - 12
	if c.title < 20 {
		c.title = 20
	}
	return c
}

func (m FilesModel) renderColumnHeader() string {
	cw := m.columnWidths()
	h := lipgloss.NewStyle().Foreground(m.theme.Subtext).Bold(true)
	cell := func(label string, width int) string {
		return h.Width(width).Render(truncateRunes(label, width))
	}
	segments := []string{
		cell("TYPE", cw.category),
		cell("MODIFIED", cw.modified),
		cell("TITLE", cw.title),
		cell("PATH", cw.path),
	}
	return lipgloss.NewStyle().Padding(0, 2).Render(" " + strings.Join(segments, " "))
}

func (m FilesModel) renderBody() string {
	if len(m.filtered) == 0 {
		return lipgloss.NewStyle().
			Foreground(m.theme.Subtext).
			Padding(1, 2).
			Render("No generated files match this filter")
	}

	start := m.scrollOffset
	end := start + m.bodyHeight()
	if end > len(m.filtered) {
		end = len(m.filtered)
	}

	var lines []string
	for i := start; i < end; i++ {
		lines = append(lines, m.renderFileLine(m.filtered[i], i == m.cursor))
	}
	return strings.Join(lines, "\n")
}

func (m FilesModel) renderFileLine(file model.GeneratedFile, selected bool) string {
	cw := m.columnWidths()
	categoryColor := m.theme.Sky
	switch file.Category {
	case "Prep":
		categoryColor = m.theme.Green
	case "Report":
		categoryColor = m.theme.Blue
	case "Output":
		categoryColor = m.theme.Yellow
	}

	category := lipgloss.NewStyle().Foreground(categoryColor).Width(cw.category).Render(file.Category)
	modified := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(cw.modified).Render(file.Modified)
	title := lipgloss.NewStyle().Foreground(m.theme.Text).Width(cw.title).Render(truncateRunes(file.Title, cw.title))
	path := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(cw.path).Render(truncateRunes(file.RelPath, cw.path))

	row := " " + strings.Join([]string{category, modified, title, path}, " ")
	if selected {
		return lipgloss.NewStyle().
			Background(m.theme.Surface).
			Foreground(m.theme.Text).
			Bold(true).
			Width(m.width - 2).
			Render("›" + row)
	}
	return lipgloss.NewStyle().Padding(0, 2).Render(" " + row)
}

func (m FilesModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if m.searchInput {
		return style.Render(
			keyStyle.Render("type") + descStyle.Render(" filter live  ") +
				keyStyle.Render("Enter") + descStyle.Render(" keep  ") +
				keyStyle.Render("Ctrl+U") + descStyle.Render(" clear  ") +
				keyStyle.Render("Esc") + descStyle.Render(" cancel"))
	}

	return style.Render(
		keyStyle.Render("↑↓/jk") + descStyle.Render(" nav  ") +
			keyStyle.Render("/") + descStyle.Render(" search  ") +
			keyStyle.Render("r") + descStyle.Render(" refresh  ") +
			keyStyle.Render("Enter") + descStyle.Render(" open  ") +
			keyStyle.Render("Esc") + descStyle.Render(" pipeline"))
}
