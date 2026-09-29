#!/usr/bin/env node
/**
 * analyze-by-level.mjs — segment application outcomes by role seniority.
 *
 * Added 2026-08-04. The standard pattern analysis aggregates across all roles,
 * which hides the thing that actually matters here: rejection rate is flat across
 * levels, but ENGAGEMENT is not. Tracking level makes that visible on every run.
 *
 * Run: node analyze-by-level.mjs          (table)
 *      node analyze-by-level.mjs --json   (machine-readable)
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';

// User-layer files resolve against the configured data root, not the codebase
// root — CAREER_OPS_ROOT / .career-ops-data may point elsewhere (v1.34).
const CAREER_OPS = getCareerOpsRoot();
const APPS = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');

const ACTIONABLE = ['Applied', 'Rejected', 'Responded', 'Interview', 'Offer', 'Discarded'];
const ENGAGED = ['Responded', 'Interview', 'Offer'];

/** Classify a job title into a seniority band. Order matters — most senior first. */
export function classifyLevel(title) {
  const t = String(title).toLowerCase();
  if (/\bvp\b|vice president|\bsvp\b|chief/.test(t)) return 'VP+';
  if (/head of|lead director|senior director|sr\.? director|executive director/.test(t)) return 'Head/Sr Dir';
  if (/\bdirector\b/.test(t)) return 'Director';
  if (/senior (engineering |software )?manager|sr\.? (engineering |software )?manager|senior manager/.test(t)) return 'Senior EM';
  if (/manager/.test(t)) return 'EM';
  if (/forward deployed|engineer/.test(t)) return 'IC/FDE';
  return 'other';
}

const ORDER = ['EM', 'Senior EM', 'Director', 'Head/Sr Dir', 'VP+', 'IC/FDE', 'other'];

function parse() {
  const rows = [];
  for (const line of readFileSync(APPS, 'utf-8').split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const c = line.split('|').slice(1, -1).map(s => s.trim());
    if (c.length < 9) continue;
    if (!ACTIONABLE.includes(c[5])) continue;
    rows.push({ num: c[0], company: c[2], title: c[3], score: c[4], status: c[5], level: classifyLevel(c[3]) });
  }
  return rows;
}

const rows = parse();
const byLevel = {};
for (const r of rows) {
  const b = (byLevel[r.level] ||= { sent: 0, rejected: 0, engaged: 0, silent: 0, rejections: [] });
  b.sent++;
  if (r.status === 'Rejected') { b.rejected++; b.rejections.push(r); }
  else if (ENGAGED.includes(r.status)) b.engaged++;
  else if (r.status === 'Applied') b.silent++;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generated: new Date().toISOString().slice(0, 10), byLevel }, null, 2));
} else {
  console.log(`\nApplication outcomes by seniority — ${new Date().toISOString().slice(0, 10)}\n`);
  console.log('level          sent  rejected  engaged  silent   rej%   engage%');
  let tS = 0, tR = 0, tE = 0;
  for (const lv of ORDER) {
    const b = byLevel[lv];
    if (!b) continue;
    tS += b.sent; tR += b.rejected; tE += b.engaged;
    const rp = ((100 * b.rejected) / b.sent).toFixed(0).padStart(4);
    const ep = ((100 * b.engaged) / b.sent).toFixed(0).padStart(6);
    console.log(
      lv.padEnd(14) + String(b.sent).padStart(4) + String(b.rejected).padStart(10) +
      String(b.engaged).padStart(9) + String(b.silent).padStart(8) + rp + '%' + ep + '%',
    );
  }
  console.log('\n' + 'TOTAL'.padEnd(14) + String(tS).padStart(4) + String(tR).padStart(10) + String(tE).padStart(9));
  console.log(`\nEngagement is the signal to watch, not rejection rate.`);
  console.log(`Rejection rate has been roughly flat across levels; engagement has not.\n`);
}
