// Apply bar. Ben lowered this from 4.0 to 3.9 on 2026-09-02; the authority is
// `apply_score_threshold` in config/profile.yml, with the reasoning in the
// "Apply Bar" section of modes/_profile.md. Keep this constant in sync with it.
// (The system-layer 4.0 in CLAUDE.md / AGENTS.md is overridden for this user.)
const APPLY_THRESHOLD = 3.9;
const READY_FILTER = "EvaluatedReady";
const OUTREACH_FILTER = "NeedsOutreach";
const SUBMITTED_STATUSES = new Set(["Applied", "Responded", "Interview", "Offer", "Rejected"]);
const STATUS_ORDER = ["Offer", "Interview", "Responded", "Applied", "Evaluated", "Rejected", "Discarded", "SKIP"];

const state = {
  companies: [],
  query: "",
  status: "All",
  columnFilters: {
    role: "",
    minScore: "",
    pdf: "All",
    evaluatedSince: "",
    jobPosting: "All",
  },
  openCompanies: new Set(),
  companySort: { key: "date", direction: "desc" },
  roleSorts: new Map(),
};

const els = {
  companyList: document.querySelector("#companyList"),
  companyCount: document.querySelector("#companyCount"),
  searchInput: document.querySelector("#companySearchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  columnFilters: document.querySelector("#columnFilters"),
  columnFilterControls: document.querySelectorAll("[data-column-filter]"),
  refreshButton: document.querySelector("#companiesRefreshButton"),
  companyMetric: document.querySelector("#companyMetric"),
  roleMetric: document.querySelector("#roleMetric"),
  submittedMetric: document.querySelector("#submittedMetric"),
  scoreMetric: document.querySelector("#scoreMetric"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return value || "Unknown date";
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function statusClass(status) {
  return `status-${String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function statusPills(statuses) {
  return Object.entries(statuses)
    .sort(([a], [b]) => {
      const left = STATUS_ORDER.indexOf(a);
      const right = STATUS_ORDER.indexOf(b);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    })
    .map(([status, count]) => `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}${count > 1 ? ` · ${count}` : ""}</span>`)
    .join("");
}

function defaultDirection(key) {
  return ["roles", "score", "date", "pdf"].includes(key) ? "desc" : "asc";
}

function toggledSort(current, key) {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: defaultDirection(key) };
}

function statusRank(status) {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}

function compareSortValues(left, right, direction) {
  const leftMissing = left === null || left === undefined || left === "";
  const rightMissing = right === null || right === undefined || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  const comparison = typeof left === "string"
    ? left.localeCompare(right, undefined, { sensitivity: "base", numeric: true })
    : left - right;
  return direction === "asc" ? comparison : -comparison;
}

function companySortValue(company, key) {
  const scores = company.roles.map((role) => role.score).filter(Number.isFinite);
  switch (key) {
    case "roles": return company.roles.length;
    case "score": return scores.length > 0 ? Math.max(...scores) : null;
    case "date": return company.roles.reduce((latest, role) => role.date > latest ? role.date : latest, "");
    case "status": return Math.min(...company.roles.map((role) => statusRank(role.status)));
    default: return company.name;
  }
}

function roleSortValue(role, key) {
  switch (key) {
    case "status": return statusRank(role.status);
    case "score": return role.score;
    case "pdf": return role.hasPDF ? 1 : 0;
    case "date": return role.date;
    default: return role.role;
  }
}

function sortedCompanies(companies) {
  const { key, direction } = state.companySort;
  return [...companies].sort((left, right) => {
    const comparison = compareSortValues(
      companySortValue(left, key),
      companySortValue(right, key),
      direction,
    );
    return comparison || left.name.localeCompare(right.name);
  });
}

function sortedRoles(company, roles) {
  const sort = state.roleSorts.get(company) || { key: "date", direction: "desc" };
  return [...roles].sort((left, right) => {
    const comparison = compareSortValues(
      roleSortValue(left, sort.key),
      roleSortValue(right, sort.key),
      sort.direction,
    );
    return comparison || right.number - left.number;
  });
}

function ariaSort(sort, key) {
  if (sort.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

function sortIndicator(sort, key) {
  if (sort.key !== key) return "↕";
  return sort.direction === "asc" ? "▲" : "▼";
}

function companySortHeader(label, key) {
  return `
    <th scope="col" aria-sort="${ariaSort(state.companySort, key)}">
      <button class="sort-button" type="button" data-company-sort="${key}">
        <span>${label}</span><span class="sort-indicator" aria-hidden="true">${sortIndicator(state.companySort, key)}</span>
      </button>
    </th>
  `;
}

function roleSortHeader(company, label, key) {
  const sort = state.roleSorts.get(company) || { key: "date", direction: "desc" };
  return `
    <th scope="col" aria-sort="${ariaSort(sort, key)}">
      <button class="sort-button" type="button" data-role-sort="${key}" data-company="${escapeHtml(company)}">
        <span>${label}</span><span class="sort-indicator" aria-hidden="true">${sortIndicator(sort, key)}</span>
      </button>
    </th>
  `;
}

function roleMatchesColumnFilters(role) {
  if (state.status === "All") return true;

  const filters = state.columnFilters;
  if (filters.role && !role.role.toLowerCase().includes(filters.role.trim().toLowerCase())) return false;

  const minScore = Number.parseFloat(filters.minScore);
  if (filters.minScore !== "" && (!Number.isFinite(role.score) || role.score < minScore)) return false;
  if (filters.pdf === "Ready" && !role.hasPDF) return false;
  if (filters.pdf === "Missing" && role.hasPDF) return false;
  if (filters.evaluatedSince && (!role.date || role.date < filters.evaluatedSince)) return false;
  if (filters.jobPosting === "Available" && !role.jobURL) return false;
  if (filters.jobPosting === "Missing" && role.jobURL) return false;
  return true;
}

function syncColumnFilters() {
  els.columnFilters.hidden = state.status === "All";
}

function matchingCompanies() {
  const query = state.query.trim().toLowerCase();

  return state.companies.map((company) => {
    const companyMatch = company.name.toLowerCase().includes(query);
    const roles = company.roles.filter((role) => {
      if (state.status === READY_FILTER) {
        if (role.status !== "Evaluated" || !Number.isFinite(role.score) || role.score < APPLY_THRESHOLD) return false;
      } else if (state.status === OUTREACH_FILTER) {
        if (!role.needsOutreach) return false;
      } else if (state.status !== "All" && role.status !== state.status) {
        return false;
      }
      if (!roleMatchesColumnFilters(role)) return false;
      if (!query || companyMatch) return true;
      return `${role.role} ${role.status} ${role.notes} ${role.scoreRaw}`.toLowerCase().includes(query);
    });
    return { ...company, roles };
  }).filter((company) => company.roles.length > 0);
}

function formatMoney(value) {
  return Number.isFinite(value) ? `$${Math.round(value).toLocaleString("en-US")}` : "";
}

function formatMoneyRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
  return min === max ? formatMoney(min) : `${formatMoney(min)} – ${formatMoney(max)}`;
}

// What to type into the application's salary field. Derived from the band the
// employer posted in their JD (read out of the evaluation report), per the comp
// rule in modes/_profile.md: anchor to THEIR band, ask midpoint-to-top, never
// below their floor and never below the walk-away floor.
function renderCompAsk(role) {
  const band = role.compBand || { min: null, max: null };
  const ask = role.compAsk || { askMin: null, askMax: null, note: "", belowFloor: false };
  const posted = band.min !== null
    ? `<span class="comp-ask-band">Employer posted ${escapeHtml(formatMoneyRange(band.min, band.max))}</span>`
    : Array.isArray(band.ranges) && band.ranges.length > 0
      ? `<span class="comp-ask-band">Employer posted ${band.ranges.map((range) => escapeHtml(formatMoneyRange(range.min, range.max))).join(" / ")}</span>`
      : "";

  if (ask.askMin === null) {
    return `
      <div class="comp-ask${ask.belowFloor ? " comp-ask-warn" : ""}">
        <span class="comp-ask-label">Ask this:</span>
        <strong class="comp-ask-value">—</strong>
        <span class="comp-ask-note">${escapeHtml(ask.note)}</span>
        ${posted}
      </div>
    `;
  }

  return `
    <div class="comp-ask">
      <span class="comp-ask-label">Ask this:</span>
      <strong class="comp-ask-value">${escapeHtml(formatMoneyRange(ask.askMin, ask.askMax))}</strong>
      ${ask.note ? `<span class="comp-ask-note">${escapeHtml(ask.note)}</span>` : ""}
      ${posted}
    </div>
  `;
}

function renderRole(role) {
  const reportHref = role.reportPath
    ? `/index.html?file=${encodeURIComponent(role.reportPath)}`
    : "";
  const outreachHref = role.outreachPath
    ? `/index.html?file=${encodeURIComponent(role.outreachPath)}`
    : "";
  const hasBeenSubmitted = SUBMITTED_STATUSES.has(role.status);

  return `
    <tr class="role-main-row">
      <td class="role-name-cell">
        <span class="role-id">#${escapeHtml(role.number)}</span>
        <strong>${escapeHtml(role.role)}</strong>
        ${role.notes ? `<p class="role-notes">${escapeHtml(role.notes)}</p>` : ""}
      </td>
      <td><span class="status-pill ${statusClass(role.status)}">${escapeHtml(role.status)}</span></td>
      <td class="table-number">${escapeHtml(role.scoreRaw || "—")}</td>
      <td>${role.hasPDF ? "Ready" : "—"}</td>
      <td>${escapeHtml(formatDate(role.date))}</td>
      <td>
        <div class="role-outreach">
          <button
            class="outreach-sent-action${role.outreachSent ? " outreach-sent-complete" : ""}"
            type="button"
            data-outreach-sent="${escapeHtml(role.number)}"
            ${role.outreachSent ? `disabled title="Outreach sent ${escapeHtml(formatDate(role.lastOutreachDate))}"` : ""}
          >${role.outreachSent ? "✓ Outreach Sent" : "Outreach Sent"}</button>
          ${outreachHref ? `<a class="secondary-action" href="${outreachHref}">Draft</a>` : ""}
          <a class="secondary-action" href="${escapeHtml(role.companyLinkedInURL)}" target="_blank" rel="noreferrer">LinkedIn</a>
        </div>
      </td>
      <td>
        <div class="role-actions">
          <button
            class="applied-action${hasBeenSubmitted ? " applied-action-complete" : ""}"
            type="button"
            data-mark-applied="${escapeHtml(role.number)}"
            ${hasBeenSubmitted ? `disabled title="Already ${escapeHtml(role.status)}"` : ""}
          >${hasBeenSubmitted ? "✓ Applied" : "Mark Applied"}</button>
          ${role.jobURL
            ? `<a class="primary-action" href="${escapeHtml(role.jobURL)}" target="_blank" rel="noreferrer">Job posting</a>`
            : `<span class="disabled-action" title="No URL was found in the evaluation report">Unavailable</span>`}
          ${reportHref
            ? `<a class="secondary-action" href="${reportHref}">Report</a>`
            : ""}
        </div>
      </td>
    </tr>
    <tr class="role-comp-row">
      <td colspan="7">${renderCompAsk(role)}</td>
    </tr>
  `;
}
async function markApplied(button) {
  const applicationNumber = Number.parseInt(button.dataset.markApplied, 10);
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    const response = await fetch(`/api/applications/${applicationNumber}/applied`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to mark this job as applied");
    await loadCompanies();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Retry";
    button.title = error.message;
    button.setAttribute("aria-label", `Retry marking as applied: ${error.message}`);
  }
}

async function markOutreachSent(button) {
  const applicationNumber = Number.parseInt(button.dataset.outreachSent, 10);
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    const response = await fetch(`/api/applications/${applicationNumber}/outreach-sent`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to mark outreach as sent");
    await loadCompanies();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Retry Outreach Sent";
    button.title = error.message;
    button.setAttribute("aria-label", `Retry marking outreach as sent: ${error.message}`);
  }
}


function renderCompanies() {
  const companies = matchingCompanies();
  const displayedCompanies = sortedCompanies(companies);
  const roles = companies.flatMap((company) => company.roles);
  const scores = roles.map((role) => role.score).filter(Number.isFinite);
  const submitted = roles.filter((role) => SUBMITTED_STATUSES.has(role.status)).length;
  const average = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;

  els.companyMetric.textContent = String(companies.length);
  els.roleMetric.textContent = String(roles.length);
  els.submittedMetric.textContent = String(submitted);
  els.scoreMetric.textContent = average === null ? "—" : `${average.toFixed(1)}/5`;
  els.companyCount.textContent = `${companies.length} ${companies.length === 1 ? "company" : "companies"} · ${roles.length} ${roles.length === 1 ? "role" : "roles"}`;

  if (companies.length === 0) {
    els.companyList.innerHTML = `<div class="empty-state"><h2>No matching companies</h2><p>Adjust the search, status, or column filters.</p></div>`;
    return;
  }

  const rows = displayedCompanies.map((company, index) => {
    const filteredStatuses = {};
    for (const role of company.roles) filteredStatuses[role.status] = (filteredStatuses[role.status] || 0) + 1;
    const scoresForCompany = company.roles.map((role) => role.score).filter(Number.isFinite);
    const topScore = scoresForCompany.length > 0 ? Math.max(...scoresForCompany) : null;
    const isOpen = state.openCompanies.has(company.name);
    const detailId = `company-roles-${index}`;
    const latestDate = company.roles.reduce((latest, role) => role.date > latest ? role.date : latest, "");
    const roleRows = sortedRoles(company.name, company.roles);

    return `
      <tr class="company-row ${isOpen ? "is-open" : ""}">
        <td>
          <button class="company-toggle" type="button" data-company-toggle="${escapeHtml(company.name)}" aria-expanded="${isOpen}" aria-controls="${detailId}">
            <span class="company-chevron" aria-hidden="true"></span>
            <strong>${escapeHtml(company.name)}</strong>
          </button>
        </td>
        <td class="table-number">${company.roles.length}</td>
        <td class="table-number">${topScore === null ? "—" : `${topScore.toFixed(1)}/5`}</td>
        <td>${escapeHtml(formatDate(latestDate))}</td>
        <td><div class="company-statuses">${statusPills(filteredStatuses)}</div></td>
      </tr>
      <tr class="company-detail-row" id="${detailId}" ${isOpen ? "" : "hidden"}>
        <td colspan="5">
          <div class="role-table-wrap">
            <table class="roles-table">
              <caption class="visually-hidden">Roles at ${escapeHtml(company.name)}</caption>
              <thead>
                <tr>
                  ${roleSortHeader(company.name, "Role", "role")}
                  ${roleSortHeader(company.name, "Status", "status")}
                  ${roleSortHeader(company.name, "Score", "score")}
                  ${roleSortHeader(company.name, "PDF", "pdf")}
                  ${roleSortHeader(company.name, "Evaluated", "date")}
                  <th scope="col">Outreach</th>
                  <th scope="col">Links</th>
                </tr>
              </thead>
              <tbody>${roleRows.map(renderRole).join("")}</tbody>
            </table>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  els.companyList.innerHTML = `
    <div class="company-table-scroll">
      <table class="companies-table">
        <caption class="visually-hidden">Tracked companies and job opportunities</caption>
        <thead>
          <tr>
            ${companySortHeader("Company", "company")}
            ${companySortHeader("Roles", "roles")}
            ${companySortHeader("Highest score", "score")}
            ${companySortHeader("Latest activity", "date")}
            ${companySortHeader("Status", "status")}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function populateStatuses() {
  const statuses = new Set(state.companies.flatMap((company) => company.roles.map((role) => role.status)));
  const sorted = [...statuses].sort((a, b) => {
    const left = STATUS_ORDER.indexOf(a);
    const right = STATUS_ORDER.indexOf(b);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
  els.statusFilter.innerHTML = `<option value="All">All statuses</option><option value="${READY_FILTER}">Evaluated, not applied · ${APPLY_THRESHOLD}+</option><option value="${OUTREACH_FILTER}">Needs outreach</option>${sorted.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join("")}`;
}

async function loadCompanies() {
  els.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/applications");
    if (!response.ok) throw new Error("Unable to load applications");
    const payload = await response.json();
    state.companies = payload.companies || [];
    populateStatuses();
    renderCompanies();
  } finally {
    els.refreshButton.disabled = false;
  }
}

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderCompanies();
});

els.statusFilter.addEventListener("change", (event) => {
  state.status = event.target.value;
  syncColumnFilters();
  renderCompanies();
});

els.columnFilterControls.forEach((control) => {
  control.addEventListener("input", (event) => {
    state.columnFilters[event.target.dataset.columnFilter] = event.target.value;
    renderCompanies();
  });
});

els.companyList.addEventListener("click", (event) => {
  const outreachSentButton = event.target.closest("button[data-outreach-sent]");
  if (outreachSentButton) {
    markOutreachSent(outreachSentButton);
    return;
  }

  const appliedButton = event.target.closest("button[data-mark-applied]");
  if (appliedButton) {
    markApplied(appliedButton);
    return;
  }

  const companySortButton = event.target.closest("button[data-company-sort]");
  if (companySortButton) {
    state.companySort = toggledSort(state.companySort, companySortButton.dataset.companySort);
    renderCompanies();
    return;
  }

  const roleSortButton = event.target.closest("button[data-role-sort]");
  if (roleSortButton) {
    const company = roleSortButton.dataset.company;
    const current = state.roleSorts.get(company) || { key: "date", direction: "desc" };
    state.roleSorts.set(company, toggledSort(current, roleSortButton.dataset.roleSort));
    renderCompanies();
    return;
  }

  const button = event.target.closest("button[data-company-toggle]");
  if (!button) return;
  const company = button.dataset.companyToggle;
  if (state.openCompanies.has(company)) state.openCompanies.delete(company);
  else state.openCompanies.add(company);
  renderCompanies();
});

els.refreshButton.addEventListener("click", () => {
  loadCompanies().catch((error) => {
    els.companyList.innerHTML = `<div class="empty-state"><h2>Could not refresh</h2><p>${escapeHtml(error.message)}</p></div>`;
  });
});

loadCompanies().catch((error) => {
  els.companyList.innerHTML = `<div class="empty-state"><h2>Could not load companies</h2><p>${escapeHtml(error.message)}</p></div>`;
});
