const state = {
  files: [],
  filtered: [],
  category: "All",
  query: "",
  selectedPath: new URLSearchParams(window.location.search).get("file") || "",
};

const els = {
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  searchInput: document.querySelector("#searchInput"),
  segments: [...document.querySelectorAll(".segment")],
  document: document.querySelector("#document"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedPath: document.querySelector("#selectedPath"),
  rawLink: document.querySelector("#rawLink"),
  refreshButton: document.querySelector("#refreshButton"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function fileMatches(file) {
  const query = state.query.trim().toLowerCase();
  const categoryMatch = state.category === "All" || file.category === state.category;
  if (!categoryMatch) return false;
  if (!query) return true;
  return `${file.title} ${file.path} ${file.category}`.toLowerCase().includes(query);
}

function applyFilters() {
  state.filtered = state.files.filter(fileMatches);
  renderFileList();
}

function syncSelectionWithFilter() {
  if (state.filtered.length === 0) {
    state.selectedPath = "";
    els.selectedTitle.textContent = "No matching files";
    els.selectedPath.textContent = "Search";
    els.rawLink.href = "#";
    els.document.innerHTML = "";
    return;
  }

  if (!state.filtered.some((file) => file.path === state.selectedPath)) {
    loadFile(state.filtered[0].path).catch((error) => {
      els.document.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    });
  }
}

function renderFileList() {
  els.fileCount.textContent = `${state.filtered.length} of ${state.files.length} files`;

  if (state.filtered.length === 0) {
    els.fileList.innerHTML = `<li class="file-item"><button type="button"><span></span><span><p class="file-title">No matches</p><p class="file-meta">Adjust the search or file type.</p></span></button></li>`;
    return;
  }

  els.fileList.innerHTML = state.filtered.map((file) => `
    <li class="file-item ${file.path === state.selectedPath ? "active" : ""}">
      <button type="button" data-path="${escapeHtml(file.path)}">
        <span class="tag ${escapeHtml(file.category)}">${escapeHtml(file.category)}</span>
        <span>
          <p class="file-title">${escapeHtml(file.title)}</p>
          <p class="file-meta">${escapeHtml(formatDate(file.modified))} - ${escapeHtml(file.path)}</p>
        </span>
      </button>
    </li>
  `).join("");
}

function renderInline(text) {
  const tokens = [];
  let safe = escapeHtml(text);

  safe = safe.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@TOKEN${tokens.length}@@`;
    tokens.push(`<code>${code}</code>`);
    return token;
  });

  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => {
    const token = `@@TOKEN${tokens.length}@@`;
    tokens.push(`<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`);
    return token;
  });

  safe = safe.replace(/(https?:\/\/[^\s<]+[^<.,;:!?\s])/g, (href) => {
    const token = `@@TOKEN${tokens.length}@@`;
    tokens.push(`<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`);
    return token;
  });

  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return tokens.reduce((html, token, index) => {
    return html.replaceAll(`@@TOKEN${index}@@`, token);
  }, safe);
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTable(lines) {
  const rows = lines
    .filter((line) => !isTableSeparator(line))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));

  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  return `
    <table>
      <thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>
      <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
}

function flushParagraph(buffer, html) {
  if (buffer.length === 0) return;
  html.push(`<p>${renderInline(buffer.join(" "))}</p>`);
  buffer.length = 0;
}

function flushList(list, html) {
  if (list.items.length === 0) return;
  const tag = list.ordered ? "ol" : "ul";
  html.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
  list.items = [];
  list.ordered = false;
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const paragraph = [];
  const list = { ordered: false, items: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph(paragraph, html);
      flushList(list, html);
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph(paragraph, html);
      flushList(list, html);
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\|.+\|$/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph(paragraph, html);
      flushList(list, html);
      const tableLines = [trimmed, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i++;
      }
      i--;
      html.push(parseTable(tableLines));
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph(paragraph, html);
      flushList(list, html);
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      flushParagraph(paragraph, html);
      flushList(list, html);
      html.push("<hr>");
      continue;
    }

    if (trimmed.startsWith("> ")) {
      flushParagraph(paragraph, html);
      flushList(list, html);
      html.push(`<blockquote>${renderInline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      flushParagraph(paragraph, html);
      if (list.items.length > 0 && list.ordered) flushList(list, html);
      list.ordered = false;
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      flushParagraph(paragraph, html);
      if (list.items.length > 0 && !list.ordered) flushList(list, html);
      list.ordered = true;
      list.items.push(ordered[1]);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph(paragraph, html);
  flushList(list, html);
  return html.join("\n");
}

async function loadFile(path) {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error("Unable to load file");
  const payload = await response.json();
  const file = state.files.find((item) => item.path === path);
  state.selectedPath = path;

  els.selectedTitle.textContent = file?.title || path;
  els.selectedPath.textContent = path;
  els.rawLink.href = `/api/file?raw=1&path=${encodeURIComponent(path)}`;
  els.document.innerHTML = markdownToHtml(payload.content);
  renderFileList();
}

async function loadFiles() {
  const response = await fetch("/api/files");
  if (!response.ok) throw new Error("Unable to load files");
  const payload = await response.json();
  state.files = payload.files || [];
  applyFilters();

  if (state.files.length > 0) {
    const preferred = state.files.find((file) => file.path === state.selectedPath) || state.files[0];
    await loadFile(preferred.path);
  }
}

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  applyFilters();
  syncSelectionWithFilter();
});

els.segments.forEach((segment) => {
  segment.addEventListener("click", () => {
    state.category = segment.dataset.category;
    els.segments.forEach((item) => item.classList.toggle("active", item === segment));
    applyFilters();
    syncSelectionWithFilter();
  });
});

els.fileList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-path]");
  if (!button) return;
  loadFile(button.dataset.path).catch((error) => {
    els.document.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  });
});

els.refreshButton.addEventListener("click", () => {
  loadFiles().catch((error) => {
    els.document.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  });
});

loadFiles().catch((error) => {
  els.document.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
});
