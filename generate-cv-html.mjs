#!/usr/bin/env node

/**
 * generate-cv-html.mjs — tailored CV markdown → template-filled HTML
 *
 * Usage:
 *   node generate-cv-html.mjs <cv.md> [output.html] [--format=letter|a4] [--lang=en]
 *   node generate-cv-html.mjs output/timely/cv-benjamin-van-wagner.md
 *
 * Defaults the output path to the input path with .html, so a package folder
 * stays self-consistent:
 *   output/{company}/cv-*.md  →  output/{company}/cv-*.html
 *
 * WHY THIS EXISTS
 * ---------------
 * modes/pdf.md asks the agent to fill templates/cv-template.html by hand, then
 * run generate-pdf.mjs on the result. Nothing rendered markdown into the
 * template, so whenever a CV claim was corrected, the .md changed and the .html
 * and .pdf silently kept the old text. On 2026-09-14 that had left a retired
 * claim ("13-engineer organization spanning 4 teams and 4 business verticals",
 * retired 2026-08-22) inside 133 files and 34 already-generated PDFs across
 * ~62 company folders. Markdown is the source of truth; this makes that true
 * in practice.
 *
 * Contact details come from config/profile.yml, never from the markdown, so
 * they cannot drift per package.
 *
 * Pipeline:
 *   cv.md → generate-cv-html.mjs → cv.html → generate-pdf.mjs → cv.pdf
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const positional = args.filter((a) => !a.startsWith('--'));

if (!positional[0]) {
  console.error('Usage: node generate-cv-html.mjs <cv.md> [output.html] [--format=letter|a4] [--lang=en]');
  process.exit(1);
}

const inputPath = resolve(positional[0]);
if (!existsSync(inputPath)) {
  console.error(`✗ Not found: ${inputPath}`);
  process.exit(1);
}
const outputPath = resolve(positional[1] || inputPath.replace(/\.md$/, '.html'));
const format = (flags.format || 'letter').toLowerCase();
const lang = flags.lang || 'en';

const md = readFileSync(inputPath, 'utf8');
const tpl = readFileSync(join(__dirname, 'templates', 'cv-template.html'), 'utf8');

const profilePath = join(__dirname, 'config', 'profile.yml');
const candidate = existsSync(profilePath)
  ? (yaml.load(readFileSync(profilePath, 'utf8'))?.candidate ?? {})
  : {};

/** Escape HTML and flatten markdown inline syntax to plain text. */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * Body text between `## Heading` and the next `## ` (or end of file).
 *
 * Deliberately compiled WITHOUT the `m` flag: with `m`, `$` matches at every
 * line ending, so the lazy `[\s\S]*?` stops at the first newline and every
 * section comes back as a single line. Anchor on `\n##` instead of `^##`.
 */
function section(heading) {
  const re = new RegExp(`(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return (md.match(re)?.[1] ?? '').trim();
}

// ── Experience ───────────────────────────────────────────────────────────────
// Workday's parser reads the first line of a job block as the job TITLE, so the
// role must lead and the company follow. Confirmed against a live Workday parse
// on 2026-08-10; do not reorder these two lines.
const WORKDAY_NOTE =
  '      <!-- Role leads, company follows. Workday\'s parser reads the first line of a\n' +
  '           job block as the job TITLE. Confirmed against a live Workday parse 2026-08-10. -->\n';

function buildExperience() {
  const body = section('Experience');
  if (!body) return '';
  return body
    .split(/\n(?=### )/)
    .map((block) => {
      const lines = block.trim().split('\n');
      const header = lines.shift().replace(/^###\s*/, '').trim();
      // "Role — Company (Location)" — em dash separates role from company.
      const m = header.match(/^(.+?)\s+—\s+(.+?)(?:\s+\((.+?)\))?$/);
      if (!m) return '';
      const [, role, company, location] = m;

      const rest = lines.join('\n');

      // Both the date line and the company-context line are italic, e.g.
      //   *April 2023 – June 2026*\
      //   *Joined Availity through its 2023 acquisition of Olive AI…*\
      // so italics alone cannot separate them — match the date shape instead,
      // or the context paragraph silently disappears from the rendered CV.
      const DATE_LINE = /^\*?\s*((?:\w+\s+)?\d{4}\s*[–-]\s*(?:(?:\w+\s+)?\d{4}|Present))\s*\*?\\?$/i;

      let dates = '';
      const contextParts = [];
      for (const raw of rest.split('\n')) {
        const t = raw.trim();
        if (!t || t.startsWith('- ')) continue;
        const dm = t.match(DATE_LINE);
        if (dm && !dates) {
          dates = dm[1].replace(/–/g, '-').trim();
          continue;
        }
        contextParts.push(t.replace(/^\*+|\*+\\?$/g, '').trim());
      }
      const context = contextParts.join(' ').trim();

      const bullets = rest
        .split('\n')
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => l.trim().slice(2).trim());

      let out = '    <div class="job">\n' + WORKDAY_NOTE;
      out += '      <div class="job-header">\n';
      out += `        <span class="job-company">${esc(role)}</span>\n`;
      out += `        <span class="job-period">${esc(dates)}</span>\n      </div>\n`;
      const loc = location ? ` <span class="job-location">(${esc(location)})</span>` : '';
      out += `      <div class="job-role">${esc(company)}${loc}</div>\n`;
      if (context) out += `      <div class="project-desc">${esc(context)}</div>\n`;
      if (bullets.length) {
        out += '      <ul>' + bullets.map((b) => `<li>${esc(b)}</li>`).join('') + '</ul>\n';
      }
      return out + '    </div>\n';
    })
    .join('');
}

// ── Competencies · Skills · Projects · Education ──────────────────────────────
function buildCompetencies() {
  return section('Core Competencies')
    .split('·')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `      <div class="competency">${esc(c)}</div>\n`)
    .join('');
}

function buildSkills() {
  const rows = section('Skills')
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => {
      const [cat, ...rest] = l.trim().slice(2).split(':');
      return `      <div class="skill-item"><span class="skill-category">${esc(cat)}:</span> ${esc(rest.join(':'))}</div>\n`;
    })
    .join('');
  return `    <div class="skills-grid">\n${rows}    </div>\n`;
}

function buildProjects() {
  return section('Projects')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((para) => {
      const title = para.match(/^\*\*(.+?)\*\*/)?.[1] ?? '';
      const badge = /\(Alpha\)/i.test(para)
        ? '<span class="project-badge">Alpha</span>'
        : '';
      // Drop the leading "**title** — " and any "(Alpha)." marker.
      let desc = para
        .replace(/^\*\*.+?\*\*\s*(—|-)?\s*/, '')
        .replace(/\[[^\]]+\]\([^)]*\)\s*/g, '')
        .replace(/\(Alpha\)\.?\s*/i, '')
        .trim();
      // The stack sentence becomes the tech line. Identified by slash-separated
      // technologies ("React with Vite / Python / PostgreSQL on Render"), which
      // is stable across packages — matching on technology NAMES is not, since
      // the description often mentions them too.
      let tech = '';
      const sentences = desc.split(/(?<=\.)\s+/);
      const techIdx = sentences.findIndex((s) => /\w\s+\/\s+\w/.test(s));
      if (techIdx !== -1) {
        tech = sentences[techIdx].replace(/\.$/, '').replace(/—/g, '-').trim();
        desc = sentences.filter((_, i) => i !== techIdx).join(' ').trim();
      }
      // Stripping the "**title** — " prefix can leave a lowercase opener.
      desc = desc.replace(/^[a-z]/, (c) => c.toUpperCase());

      let out = `    <div class="project">\n      <span class="project-title">${esc(title)}</span>${badge}\n`;
      if (desc) out += `      <div class="project-desc">${esc(desc)}</div>\n`;
      if (tech) out += `      <div class="project-tech">${esc(tech)}</div>\n`;
      return out + '    </div>\n';
    })
    .join('');
}

function buildEducation() {
  const body = section('Education');
  if (!body) return '';
  const title = body.match(/\*\*(.+?)\*\*/)?.[1] ?? '';
  const schoolLine = body.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const years = schoolLine.match(/(\d{4}\s*[–-]\s*\d{4})/)?.[1]?.replace(/–/g, '-') ?? '';
  const school = schoolLine.replace(/,?\s*\d{4}\s*[–-]\s*\d{4}\.?$/, '').trim();
  return (
    '    <div class="edu-item">\n      <div class="edu-header">\n' +
    `        <span class="edu-title">${esc(title)}</span>\n` +
    `        <span class="edu-period">${esc(years)}</span>\n      </div>\n` +
    `      <div class="edu-school">${esc(school)}</div>\n    </div>\n`
  );
}

// ── Fill ─────────────────────────────────────────────────────────────────────
const linkedin = candidate.linkedin ?? '';
const values = {
  LANG: lang,
  PAGE_WIDTH: format === 'a4' ? '210mm' : '8.5in',
  NAME: esc(candidate.full_name ?? md.match(/^#\s+(.+)$/m)?.[1] ?? ''),
  PHONE: esc(candidate.phone ?? ''),
  EMAIL: esc(candidate.email ?? ''),
  LINKEDIN_URL: linkedin.startsWith('http') ? linkedin : `https://www.${linkedin}`,
  LINKEDIN_DISPLAY: esc(linkedin),
  PORTFOLIO_URL: candidate.portfolio_url ?? '',
  PORTFOLIO_DISPLAY: esc((candidate.portfolio_url ?? '').replace(/^https?:\/\//, '')),
  LOCATION: esc(candidate.location ?? ''),
  SECTION_SUMMARY: 'Summary',
  SUMMARY_TEXT: esc(section('Summary')),
  SECTION_COMPETENCIES: 'Core Competencies',
  COMPETENCIES: buildCompetencies(),
  SECTION_EXPERIENCE: 'Experience',
  EXPERIENCE: buildExperience(),
  SECTION_PROJECTS: 'Projects',
  PROJECTS: buildProjects(),
  SECTION_SKILLS: 'Skills',
  SKILLS: buildSkills(),
  SECTION_EDUCATION: 'Education',
  EDUCATION: buildEducation(),
};

let html = tpl;
for (const [key, value] of Object.entries(values)) {
  html = html.split(`{{${key}}}`).join(value);
}

/**
 * Drop whole sections that have no content.
 *
 * `.section-title` carries `border-bottom: 1.5px solid`, so an empty section
 * still paints a stray horizontal rule across the page. Some older packages
 * (e.g. output/25madison) have no `## Core Competencies` heading at all.
 */
const EMPTY_SECTIONS = [
  { when: !values.COMPETENCIES.trim(), re: /\n\s*<div class="section">\s*<div class="section-title">Core Competencies<\/div>\s*<div class="competencies-grid">\s*<\/div>\s*<\/div>/ },
  { when: !values.PROJECTS.trim(), re: /\n\s*<div class="section avoid-break">\s*<div class="section-title">Projects<\/div>\s*<\/div>/ },
  { when: !values.EDUCATION.trim(), re: /\n\s*<div class="section avoid-break">\s*<div class="section-title">Education<\/div>\s*<\/div>/ },
];
const dropped = [];
for (const { when, re } of EMPTY_SECTIONS) {
  if (!when) continue;
  const before = html;
  html = html.replace(re, '');
  if (html !== before) dropped.push(re.source.match(/section-title">([A-Za-z ]+)</)?.[1] ?? 'section');
}

const unfilled = [...new Set(html.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
if (unfilled.length) {
  console.error(`✗ Unfilled placeholders: ${unfilled.join(', ')}`);
  process.exit(1);
}

writeFileSync(outputPath, html, 'utf8');

const jobCount = (values.EXPERIENCE.match(/<div class="job">/g) ?? []).length;
console.log(`📄 Input:  ${inputPath}`);
console.log(`📁 Output: ${outputPath}`);
console.log(`📏 Format: ${format.toUpperCase()}`);
console.log(`✅ HTML generated — ${jobCount} roles, ${(values.COMPETENCIES.match(/competency/g) ?? []).length} competencies`);
if (dropped.length) console.log(`   ⚠ empty section(s) omitted: ${dropped.join(', ')}`);
console.log(`→ Next: node generate-pdf.mjs "${outputPath}" "${outputPath.replace(/\.html$/, '.pdf')}" --format=${format}`);
