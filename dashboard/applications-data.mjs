import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  computeUrgency,
  daysBetween,
  normalizeStatus,
  parseDate,
  resolveCadenceConfig,
} from "../followup-cadence.mjs";

const SUBMITTED_STATUSES = new Set(["Applied", "Responded", "Interview", "Offer", "Rejected"]);

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findTrackerPath(careerOpsPath) {
  const candidates = [
    path.join(careerOpsPath, "applications.md"),
    path.join(careerOpsPath, "data", "applications.md"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function splitMarkdownRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function markdownLinkTarget(value) {
  return /\[[^\]]+\]\(([^)]+)\)/.exec(value)?.[1] || "";
}

async function resolveReportPath(careerOpsPath, trackerPath, trackerLink) {
  if (!trackerLink || path.isAbsolute(trackerLink)) return "";

  const candidates = [
    path.resolve(path.dirname(trackerPath), trackerLink),
    path.resolve(careerOpsPath, trackerLink),
  ];

  for (const candidate of candidates) {
    const relative = path.relative(careerOpsPath, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(candidate) !== ".md") {
      continue;
    }
    if (await fileExists(candidate)) {
      return relative.split(path.sep).join("/");
    }
  }
  return "";
}

async function reportJobURL(careerOpsPath, reportPath) {
  if (!reportPath) return "";
  try {
    const content = await readFile(path.join(careerOpsPath, reportPath), "utf8");
    const match = /^\*\*URL:\*\*\s*(https?:\/\/\S+)/m.exec(content.slice(0, 4000));
    if (!match) return "";
    const parsed = new URL(match[1]);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function parseTrackerRows(content) {
  const rows = [];

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const fields = splitMarkdownRow(line);
    if (fields.length < 8 || fields[0] === "#" || /^-+$/.test(fields[0])) continue;

    const number = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(number)) continue;
    const scoreMatch = /(\d+(?:\.\d+)?)\/5/.exec(fields[4]);

    rows.push({
      number,
      date: fields[1],
      company: fields[2],
      role: fields[3],
      score: scoreMatch ? Number.parseFloat(scoreMatch[1]) : null,
      scoreRaw: fields[4],
      status: fields[5],
      hasPDF: fields[6].includes("✅"),
      reportLink: markdownLinkTarget(fields[7]),
      notes: fields.slice(8).join(" | "),
    });
  }

  return rows;
}

const GENERIC_ROLE_TOKENS = new Set([
  "a", "an", "and", "director", "em", "engineer", "engineering", "head",
  "manager", "of", "outreach", "recruiter", "remote", "role", "senior",
  "software", "sr", "the",
]);

function slugTokens(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function companyKey(value) {
  return slugTokens(value).join("-");
}

function reportNumber(value) {
  const match = /(?:^|\/)(\d+)[^/]*\.md(?:$|[?#])/i.exec(value || "");
  return match ? Number.parseInt(match[1], 10) : null;
}

function directLinkedInCompanyURL(content) {
  const match = /https:\/\/(?:www\.)?linkedin\.com\/company\/[^)\s>"']+/i.exec(content);
  if (!match) return "";
  try {
    const url = new URL(match[0]);
    return url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

async function findOutreachFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findOutreachFiles(entryPath));
    } else if (entry.isFile() && /outreach.*\.md$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function loadRoleOutreachLinks(careerOpsPath, roles) {
  const outputRoot = path.join(careerOpsPath, "output");
  const files = await findOutreachFiles(outputRoot);
  const artifacts = await Promise.all(files.map(async (filePath) => {
    const relativePath = path.relative(careerOpsPath, filePath).split(path.sep).join("/");
    const outputRelative = path.relative(outputRoot, filePath).split(path.sep);
    const content = await readFile(filePath, "utf8");
    const reportNumbers = new Set(
      [...content.matchAll(/reports\/(\d+)/gi)]
        .map((match) => Number.parseInt(match[1], 10)),
    );
    return {
      company: companyKey(outputRelative[0]),
      contentTokens: new Set(slugTokens(`${relativePath} ${content.slice(0, 2000)}`)),
      directLinkedInURL: directLinkedInCompanyURL(content),
      path: relativePath,
      reportNumbers,
    };
  }));
  artifacts.sort((left, right) => right.path.localeCompare(left.path));

  const artifactsByCompany = new Map();
  for (const artifact of artifacts) {
    if (!artifactsByCompany.has(artifact.company)) artifactsByCompany.set(artifact.company, []);
    artifactsByCompany.get(artifact.company).push(artifact);
  }

  const roleCounts = new Map();
  for (const role of roles) {
    const key = companyKey(role.company);
    roleCounts.set(key, (roleCounts.get(key) || 0) + 1);
  }

  const linksByApplication = new Map();
  for (const role of roles) {
    const key = companyKey(role.company);
    const candidates = artifactsByCompany.get(key) || [];
    const roleReportNumber = reportNumber(role.reportLink);
    const distinctiveRoleTokens = slugTokens(role.role)
      .filter((token) => !GENERIC_ROLE_TOKENS.has(token) && !/^\d+$/.test(token));
    const outreach = candidates.find((candidate) => (
      roleReportNumber !== null && candidate.reportNumbers.has(roleReportNumber)
    )) || candidates.find((candidate) => (
      distinctiveRoleTokens.length > 0
      && distinctiveRoleTokens.every((token) => candidate.contentTokens.has(token))
    )) || (
      roleCounts.get(key) === 1 && candidates.length === 1 ? candidates[0] : null
    );
    const directLinkedInURL = candidates.find((candidate) => candidate.directLinkedInURL)
      ?.directLinkedInURL;

    linksByApplication.set(role.number, {
      outreachPath: outreach?.path || "",
      companyLinkedInURL: directLinkedInURL
        || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(role.company.trim())}`,
    });
  }
  return linksByApplication;
}

const FOLLOWUPS_HEADER = `# Follow-Up History

Tracks recruiter/hiring-manager follow-ups per application. Read by \`followup-cadence.mjs\` to reset cadence and re-flag if a contact goes quiet.

| # | App# | Date | Company | Role | Channel | Contact | Notes |
|---|------|------|---------|------|---------|---------|-------|`;

function parseFollowupRows(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const fields = splitMarkdownRow(line);
    const number = Number.parseInt(fields[0], 10);
    const applicationNumber = Number.parseInt(fields[1], 10);
    const date = fields[2];
    const parsedDate = parseDate(date);
    if (!Number.isFinite(number) || !Number.isFinite(applicationNumber) || !parsedDate) continue;
    rows.push({ number, applicationNumber, date, parsedDate });
  }
  return rows;
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\r?\n/g, " ").replaceAll("|", "\\|").trim();
}

function appliedDateFor(role) {
  return /\bapplied(?:\s+on)?\s+(\d{4}-\d{2}-\d{2})\b/i
    .exec(`${role.status} ${role.notes}`)?.[1] || "";
}

async function loadOutreachByApplication(careerOpsPath, roles, now) {
  const followupsByApplication = new Map();
  try {
    const content = await readFile(path.join(careerOpsPath, "data", "follow-ups.md"), "utf8");
    for (const followup of parseFollowupRows(content)) {
      const current = followupsByApplication.get(followup.applicationNumber)
        || { count: 0, latestDate: null };
      current.count++;
      if (!current.latestDate || followup.parsedDate > current.latestDate) {
        current.latestDate = followup.parsedDate;
      }
      followupsByApplication.set(followup.applicationNumber, current);
    }
  } catch {
    // No follow-up history yet.
  }

  const cadence = resolveCadenceConfig({
    profilePath: path.join(careerOpsPath, "config", "profile.yml"),
  });
  const analysisDate = new Date(now.toISOString().slice(0, 10));
  const outreachByApplication = new Map();

  for (const role of roles) {
    const followups = followupsByApplication.get(role.number) || { count: 0, latestDate: null };
    const sentState = {
      outreachSent: followups.count > 0,
      lastOutreachDate: followups.latestDate?.toISOString().slice(0, 10) || "",
    };
    const status = normalizeStatus(role.status);
    const applicationDate = parseDate(role.date);
    if (!["applied", "responded", "interview"].includes(status) || !applicationDate) {
      outreachByApplication.set(role.number, {
        needsOutreach: false,
        outreachUrgency: "",
        ...sentState,
      });
      continue;
    }

    const urgency = computeUrgency(
      status,
      daysBetween(applicationDate, analysisDate),
      followups.latestDate ? daysBetween(followups.latestDate, analysisDate) : null,
      followups.count,
      cadence,
    );
    outreachByApplication.set(role.number, {
      needsOutreach: urgency === "urgent" || urgency === "overdue",
      outreachUrgency: urgency,
      ...sentState,
    });
  }

  return outreachByApplication;
}

function replaceMarkdownCell(line, cellIndex, value) {
  const separators = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "|" && line[index - 1] !== "\\") separators.push(index);
  }

  if (separators.length <= cellIndex + 1) {
    throw new Error("Invalid applications tracker row");
  }

  const start = separators[cellIndex] + 1;
  const end = separators[cellIndex + 1];
  const cell = line.slice(start, end);
  const leadingSpace = /^\s*/.exec(cell)[0];
  const trailingSpace = /\s*$/.exec(cell)[0];
  return `${line.slice(0, start)}${leadingSpace}${value}${trailingSpace}${line.slice(end)}`;
}

export async function markApplicationApplied(
  careerOpsPath,
  applicationNumber,
  { date = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!Number.isInteger(applicationNumber) || applicationNumber < 1) {
    throw new Error("Invalid application number");
  }
  if (!parseDate(date)) {
    throw new Error("Invalid applied date");
  }

  const trackerPath = await findTrackerPath(careerOpsPath);
  if (!trackerPath) return null;

  const tracker = await readFile(trackerPath, "utf8");
  const lines = tracker.split("\n");
  const matchingLines = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) continue;
    const fields = splitMarkdownRow(line);
    if (Number.parseInt(fields[0], 10) === applicationNumber) matchingLines.push({ index, fields });
  }

  if (matchingLines.length === 0) return null;
  if (matchingLines.length > 1) throw new Error(`Duplicate application number: ${applicationNumber}`);

  const match = matchingLines[0];
  if (SUBMITTED_STATUSES.has(match.fields[5])) {
    return { status: match.fields[5], changed: false };
  }

  const existingNotes = match.fields.slice(8).join(" | ").replace(/[.\s]+$/, "");
  const notes = existingNotes ? `${existingNotes}. Applied ${date}.` : `Applied ${date}.`;
  let updatedLine = replaceMarkdownCell(lines[match.index], 5, "Applied");
  updatedLine = replaceMarkdownCell(updatedLine, 8, escapeMarkdownCell(notes));
  lines[match.index] = updatedLine;
  await writeFile(trackerPath, lines.join("\n"));
  return { status: "Applied", appliedDate: date, changed: true };
}

export async function markApplicationOutreachSent(
  careerOpsPath,
  applicationNumber,
  { date = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!Number.isInteger(applicationNumber) || applicationNumber < 1) {
    throw new Error("Invalid application number");
  }
  if (!parseDate(date)) {
    throw new Error("Invalid outreach date");
  }

  const trackerPath = await findTrackerPath(careerOpsPath);
  if (!trackerPath) return null;
  const trackerRows = parseTrackerRows(await readFile(trackerPath, "utf8"))
    .filter((role) => role.number === applicationNumber);
  if (trackerRows.length === 0) return null;
  if (trackerRows.length > 1) throw new Error(`Duplicate application number: ${applicationNumber}`);

  const followupsPath = path.join(careerOpsPath, "data", "follow-ups.md");
  let content = "";
  try {
    content = await readFile(followupsPath, "utf8");
  } catch {
    // Create the history file on the first recorded outreach.
  }
  const followups = parseFollowupRows(content);
  const existing = followups
    .filter((followup) => followup.applicationNumber === applicationNumber)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  if (existing) {
    return { outreachSent: true, lastOutreachDate: existing.date, changed: false };
  }

  const role = trackerRows[0];
  const nextNumber = followups.reduce((max, followup) => Math.max(max, followup.number), 0) + 1;
  const line = `| ${nextNumber} | ${applicationNumber} | ${date} | ${escapeMarkdownCell(role.company)} | ${escapeMarkdownCell(role.role)} | Outreach | — | Marked sent from dashboard |`;
  await mkdir(path.dirname(followupsPath), { recursive: true });
  await writeFile(followupsPath, `${content.trimEnd() || FOLLOWUPS_HEADER}\n${line}\n`);
  return { outreachSent: true, lastOutreachDate: date, changed: true };
}

// -- Compensation ------------------------------------------------------
// Derived, not stored. The dashboard reads the employer's posted band from
// each evaluation report and applies the ask rule from config/profile.yml.

function parseMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim().replace(/[$,\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(raw);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]) * (match[2] ? 1000 : 1);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Reports write bands both as "225,000" and as "225K"; normalise the latter.
  return Math.round(amount < 1000 ? amount * 1000 : amount);
}

// Report formats vary across evaluation generations, so match source labels
// and ranges independently instead of depending on one summary-table shape.
const COMPENSATION_LABEL_PATTERN = /\b(?:comp(?:ensation)?|salary|pay|posted|job posting|jd(?:-stated)?)\b/i;
const NON_EMPLOYER_LABEL_PATTERN = /\b(?:candidate|target|floor|market|levels|glassdoor|median|benchmark|ic)\b/i;
const POSTED_BAND_LABEL_PATTERN = /\b(?:posted\s+(?:band|range|comp(?:ensation)?|salary|pay)|(?:comp(?:ensation)?|salary|pay)\s+posted|job posting|jd(?:-stated)?)\b/i;
const NO_POSTED_BAND_PATTERN = /^(?:none|n\/a|not\s+(?:disclosed|published|provided|stated)|un(?:disclosed|published)|no\s+(?:band|range|salary|compensation|pay))\b/i;
const PAY_RANGE_PATTERN = /\$\s?(\d[\d,.]*\s?k?)\s*(?:\/\s*(?:yr|year)|per\s+year|annually)?\s*(?:–|—|-|to)\s*\$?\s?(\d[\d,.]*\s?k?)/gi;
const FIXED_PAY_PATTERN = /\$\s?(\d[\d,.]*\s?k?).*?\b(?:flat|fixed|single point|single figure|not a range)\b/i;

function parsePayRanges(value) {
  const ranges = [];
  for (const match of String(value).matchAll(PAY_RANGE_PATTERN)) {
    const min = parseMoney(match[1]);
    const max = parseMoney(match[2]);
    if (min !== null && max !== null && max >= min) {
      ranges.push({ min, max, index: match.index });
    }
  }
  return ranges;
}

function rangeNearMarker(scope, ranges, pattern) {
  const marker = pattern.exec(scope);
  if (!marker) return null;
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    const distance = Math.abs(range.index - marker.index);
    if (distance < nearestDistance) {
      nearest = range;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 220 ? nearest : null;
}

function selectPayBand(scope, location) {
  const ranges = parsePayRanges(scope);
  if (ranges.length === 0) {
    const fixed = FIXED_PAY_PATTERN.exec(scope);
    const amount = fixed ? parseMoney(fixed[1]) : null;
    return amount === null ? null : { min: amount, max: amount };
  }
  if (ranges.length === 1) return { min: ranges[0].min, max: ranges[0].max };

  const state = String(location?.state || "").trim();
  if (state) {
    const escapedState = state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stateRange = rangeNearMarker(scope, ranges, new RegExp(`\\b${escapedState}\\b`, "i"));
    if (stateRange) return { min: stateRange.min, max: stateRange.max };
  }

  const allOther = rangeNearMarker(scope, ranges, /\ball other(?:\s+(?:states|locations?))?\b/i);
  if (allOther) return { min: allOther.min, max: allOther.max };

  const country = String(location?.country || "").toLowerCase();
  const countryPattern = country.includes("united states")
    ? /\b(?:usa|us|united states)\s*:/i
    : country.includes("canada")
      ? /\bcanada\s*:/i
      : null;
  const countryRange = countryPattern ? rangeNearMarker(scope, ranges, countryPattern) : null;
  if (countryRange) return { min: countryRange.min, max: countryRange.max };

  const standardRange = rangeNearMarker(scope, ranges, /\b(?:nationally|standard us|most remote locations?)\b/i);
  if (standardRange) return { min: standardRange.min, max: standardRange.max };

  const uniqueRanges = ranges
    .filter((range, index) => !ranges.slice(0, index).some((prior) => prior.min === range.min && prior.max === range.max))
    .map(({ min, max }) => ({ min, max }));
  return { min: null, max: null, ranges: uniqueRanges };
}

/** Pull the employer's posted band from the report's table, metadata, or JD prose. */
export function parseCompBand(content, location = {}) {
  const candidates = [];

  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|")) {
      const cells = splitMarkdownRow(trimmed);
      const label = (cells[0] || "").replace(/[*_`]/g, "");
      const value = cells.slice(1).join(" | ");
      const plainValue = value.replace(/[*_`]/g, "").trim();
      // An explicit "posted band: none" is authoritative. Do not let market,
      // adjacent-role, or aggregator figures later in the report override it.
      if (POSTED_BAND_LABEL_PATTERN.test(label) && NO_POSTED_BAND_PATTERN.test(plainValue)) {
        return { min: null, max: null };
      }
      if (COMPENSATION_LABEL_PATTERN.test(label) && !NON_EMPLOYER_LABEL_PATTERN.test(label)) {
        candidates.push(value);
      }
    }

    const metadata = /^\s*(?:comp(?:ensation)?|comp_[a-z_]*range|salary_range|pay_range)\s*:\s*["']?(.+?)["']?\s*$/i.exec(line);
    if (metadata) candidates.push(metadata[1]);

    if (/\b(?:per the jd|job posting|posted (?:base|salary|compensation|range)|base salary range|pay range)\b/i.test(line)) {
      candidates.push(line);
    }
  }

  for (const candidate of candidates) {
    const band = selectPayBand(candidate, location);
    if (band) return band;
  }
  return { min: null, max: null };
}

async function reportCompBand(careerOpsPath, reportPath, location) {
  if (!reportPath) return { min: null, max: null };
  try {
    const content = await readFile(path.join(careerOpsPath, reportPath), "utf8");
    return parseCompBand(content, location);
  } catch {
    return { min: null, max: null };
  }
}

async function loadCompProfile(careerOpsPath) {
  try {
    const content = await readFile(path.join(careerOpsPath, "config", "profile.yml"), "utf8");
    const minimum = /^\s*minimum:\s*"?\$?([\d,.]+\s?k?)"?/im.exec(content);
    const target = /^\s*target_range:\s*["']?([^"'#\n]+)["']?/im.exec(content);
    const country = /^\s*country:\s*["']?([^"'#\n]+)["']?/im.exec(content);
    const city = /^\s*city:\s*["']?([^"'#\n]+)["']?/im.exec(content);
    return {
      baseFloor: minimum ? parseMoney(minimum[1]) : null,
      targetBand: target ? selectPayBand(target[1], {}) : null,
      location: {
        country: country?.[1].trim() || "",
        state: /,\s*([A-Z]{2})\b/.exec(city?.[1] || "")?.[1] || "",
      },
    };
  } catch {
    return { baseFloor: null, targetBand: null, location: {} };
  }
}

/**
 * Recommend the midpoint-to-top of the applicable employer band, raised to
 * the walk-away floor when that band straddles it.
 */
export function recommendAsk(band, baseFloor, targetBand = null) {
  const provisionalTarget = targetBand && targetBand.min !== null && targetBand.max !== null
    ? { askMin: targetBand.min, askMax: targetBand.max, belowFloor: false }
    : null;

  if (Array.isArray(band.ranges) && band.ranges.length > 1) {
    return provisionalTarget
      ? { ...provisionalTarget, note: "Provisional target — verify which employer location band applies" }
      : { askMin: null, askMax: null, note: "Multiple location bands — verify which one applies before answering", belowFloor: false };
  }
  if (band.min === null || band.max === null) {
    return provisionalTarget
      ? { ...provisionalTarget, note: "Your target range — employer did not publish a band" }
      : { askMin: null, askMax: null, note: "No published band — ask the recruiter before entering a number", belowFloor: false };
  }
  if (baseFloor !== null && band.max < baseFloor) {
    return provisionalTarget
      ? { ...provisionalTarget, note: "Your target range — employer's whole band is under your floor", belowFloor: true }
      : { askMin: null, askMax: null, note: "Whole band is under your floor", belowFloor: true };
  }
  const midpoint = Math.round((band.min + band.max) / 2);
  const askMin = baseFloor === null ? midpoint : Math.max(midpoint, baseFloor);
  return { askMin, askMax: band.max, note: "", belowFloor: false };
}

export async function loadCompanyApplications(careerOpsPath, { now = new Date() } = {}) {
  const trackerPath = await findTrackerPath(careerOpsPath);
  if (!trackerPath) {
    return {
      companies: [],
      summary: { companyCount: 0, roleCount: 0, submittedCount: 0, averageScore: null, statuses: {} },
    };
  }

  const tracker = await readFile(trackerPath, "utf8");
  const parsedRows = parseTrackerRows(tracker);
  const outreachByApplication = await loadOutreachByApplication(careerOpsPath, parsedRows, now);
  const outreachLinksByApplication = await loadRoleOutreachLinks(careerOpsPath, parsedRows);
  const compProfile = await loadCompProfile(careerOpsPath);
  const roles = await Promise.all(parsedRows.map(async (role) => {
    const reportPath = await resolveReportPath(careerOpsPath, trackerPath, role.reportLink);
    const outreach = outreachByApplication.get(role.number) || {
      needsOutreach: false,
      outreachUrgency: "",
      outreachSent: false,
      lastOutreachDate: "",
    };
    const outreachLinks = outreachLinksByApplication.get(role.number);
    const compBand = await reportCompBand(careerOpsPath, reportPath, compProfile.location);
    return {
      compBand,
      compAsk: recommendAsk(compBand, compProfile.baseFloor, compProfile.targetBand),
      number: role.number,
      date: role.date,
      company: role.company,
      role: role.role,
      score: role.score,
      scoreRaw: role.scoreRaw,
      status: role.status,
      hasPDF: role.hasPDF,
      reportPath,
      jobURL: await reportJobURL(careerOpsPath, reportPath),
      notes: role.notes,
      appliedDate: appliedDateFor(role),
      ...outreachLinks,
      ...outreach,
    };
  }));

  const grouped = new Map();
  for (const role of roles) {
    const key = role.company.trim().toLocaleLowerCase();
    if (!grouped.has(key)) grouped.set(key, { name: role.company.trim(), roles: [] });
    grouped.get(key).roles.push(role);
  }

  const companies = [...grouped.values()].map((company) => {
    company.roles.sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);
    const numericScores = company.roles.map((role) => role.score).filter(Number.isFinite);
    const statuses = {};
    for (const role of company.roles) statuses[role.status] = (statuses[role.status] || 0) + 1;

    return {
      ...company,
      roleCount: company.roles.length,
      submittedCount: company.roles.filter((role) => SUBMITTED_STATUSES.has(role.status)).length,
      topScore: numericScores.length > 0 ? Math.max(...numericScores) : null,
      latestDate: company.roles[0]?.date || "",
      statuses,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const scores = roles.map((role) => role.score).filter(Number.isFinite);
  const statuses = {};
  for (const role of roles) statuses[role.status] = (statuses[role.status] || 0) + 1;

  return {
    companies,
    summary: {
      companyCount: companies.length,
      roleCount: roles.length,
      submittedCount: roles.filter((role) => SUBMITTED_STATUSES.has(role.status)).length,
      averageScore: scores.length > 0
        ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
        : null,
      statuses,
    },
  };
}
