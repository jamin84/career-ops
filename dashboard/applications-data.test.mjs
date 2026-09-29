import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadCompanyApplications,
  markApplicationApplied,
  markApplicationOutreachSent,
  parseCompBand,
  recommendAsk,
} from "./applications-data.mjs";

test("groups tracker roles by company and enriches them with job posting URLs", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "career-ops-dashboard-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  const reportsDir = path.join(tempRoot, "reports");
  const outreachDir = path.join(tempRoot, "output", "acme");
  await Promise.all([mkdir(dataDir), mkdir(reportsDir), mkdir(outreachDir, { recursive: true })]);

  const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 7 | 2026-07-20 | Acme | Engineering Manager | 4.5/5 | Applied | ✅ | [007](../reports/007-acme-em.md) | Healthcare \\| AI fit |
| 8 | 2026-07-21 | Acme | Director of Engineering | 3.8/5 | Evaluated | ❌ | [008](../reports/008-acme-director.md) | Strong leadership fit |
| 9 | 2026-07-19 | Beta Labs | VP Engineering | 2.5/5 | SKIP | ❌ | — | Location mismatch |
`;
  await writeFile(path.join(dataDir, "applications.md"), tracker);
  await writeFile(
    path.join(reportsDir, "007-acme-em.md"),
    `# Acme\n\n**URL:** https://jobs.example.com/acme/em\n\n${"x".repeat(6500)}\n\n| Compensation signal | $220,000 - $280,000 |\n`,
  );
  await writeFile(path.join(reportsDir, "008-acme-director.md"), "# Acme\n\n**URL:** https://jobs.example.com/acme/director\n");
  await writeFile(
    path.join(outreachDir, "outreach-acme-em.md"),
    "# Outreach — Acme Engineering Manager\n\n**Report:** reports/007-acme-em.md\n\n[Acme LinkedIn](https://www.linkedin.com/company/acme)\n",
  );

  const result = await loadCompanyApplications(tempRoot);

  assert.equal(result.summary.companyCount, 2);
  assert.equal(result.summary.roleCount, 3);
  assert.equal(result.summary.submittedCount, 1);
  assert.equal(result.companies[0].name, "Acme");
  assert.equal(result.companies[0].roleCount, 2);
  assert.equal(result.companies[0].topScore, 4.5);
  assert.equal(result.companies[0].submittedCount, 1);
  assert.equal(result.companies[0].roles[0].role, "Director of Engineering");
  assert.equal(result.companies[0].roles[1].jobURL, "https://jobs.example.com/acme/em");
  assert.equal(result.companies[0].roles[1].reportPath, "reports/007-acme-em.md");
  assert.deepEqual(result.companies[0].roles[1].compBand, { min: 220000, max: 280000 });
  assert.deepEqual(result.companies[0].roles[1].compAsk, {
    askMin: 250000,
    askMax: 280000,
    note: "",
    belowFloor: false,
  });
  assert.equal(result.companies[0].roles[1].notes, "Healthcare | AI fit");
  assert.equal(result.companies[0].roles[1].outreachPath, "output/acme/outreach-acme-em.md");
  assert.equal(result.companies[0].roles[0].outreachPath, "");
  assert.equal(result.companies[0].roles[0].companyLinkedInURL, "https://www.linkedin.com/company/acme");
  assert.equal(result.companies[1].roles[0].jobURL, "");
  assert.equal(
    result.companies[1].roles[0].companyLinkedInURL,
    "https://www.linkedin.com/search/results/companies/?keywords=Beta%20Labs",
  );
});

test("marks a tracker row as Applied without downgrading later statuses", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "career-ops-dashboard-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  await mkdir(dataDir);

  const trackerPath = path.join(dataDir, "applications.md");
  const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 7 | 2026-07-20 | Acme | Engineering Manager | 4.5/5 | Evaluated | ✅ | — | Healthcare \\| AI fit |
| 8 | 2026-07-21 | Beta | Staff Engineer | 4.2/5 | Rejected | ❌ | — | Keep this status |
`;
  await writeFile(trackerPath, tracker);

  assert.deepEqual(
    await markApplicationApplied(tempRoot, 7, { date: "2026-07-27" }),
    { status: "Applied", appliedDate: "2026-07-27", changed: true },
  );
  assert.deepEqual(await markApplicationApplied(tempRoot, 8), { status: "Rejected", changed: false });

  const updatedTracker = await readFile(trackerPath, "utf8");
  assert.match(updatedTracker, /\| 7 \| 2026-07-20 \| Acme \| Engineering Manager \| 4\.5\/5 \| Applied \| ✅ \| — \| Healthcare \\\| AI fit\. Applied 2026-07-27\. \|/);
  assert.match(updatedTracker, /\| 8 \| 2026-07-21 \| Beta \| Staff Engineer \| 4\.2\/5 \| Rejected \|/);

  const applications = await loadCompanyApplications(tempRoot);
  const appliedRole = applications.companies
    .flatMap((company) => company.roles)
    .find((role) => role.number === 7);
  assert.equal(appliedRole.appliedDate, "2026-07-27");
});

test("flags only urgent and overdue applications as needing outreach", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "career-ops-dashboard-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  await mkdir(dataDir);

  const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 10 | 2026-07-20 | Acme | Overdue Applied | 4.5/5 | Applied | ✅ | — | No outreach yet |
| 11 | 2026-07-10 | Beta | Follow-up Limit | 4.2/5 | Applied | ✅ | — | Two follow-ups sent |
| 12 | 2026-07-26 | Gamma | Interview Follow-up | 4.4/5 | Interview | ✅ | — | Send thank-you |
| 13 | 2026-07-01 | Delta | Not Applied | 4.1/5 | Evaluated | ✅ | — | Not actionable |
`;
  const followups = `# Follow-Up History

| # | App# | Date | Company | Role | Channel | Contact | Notes |
|---|------|------|---------|------|---------|---------|-------|
| 1 | 11 | 2026-07-15 | Beta | Follow-up Limit | LinkedIn | Recruiter | First |
| 2 | 11 | 2026-07-22 | Beta | Follow-up Limit | Email | Recruiter | Second |
`;
  await writeFile(path.join(dataDir, "applications.md"), tracker);
  await writeFile(path.join(dataDir, "follow-ups.md"), followups);

  const result = await loadCompanyApplications(tempRoot, {
    now: new Date("2026-07-27T12:00:00Z"),
  });
  const roles = new Map(
    result.companies
      .flatMap((company) => company.roles)
      .map((role) => [role.number, role]),
  );

  assert.deepEqual(
    [roles.get(10).needsOutreach, roles.get(10).outreachUrgency],
    [true, "overdue"],
  );
  assert.deepEqual(
    [roles.get(11).needsOutreach, roles.get(11).outreachUrgency],
    [false, "cold"],
  );
  assert.deepEqual(
    [roles.get(12).needsOutreach, roles.get(12).outreachUrgency],
    [true, "overdue"],
  );
  assert.deepEqual(
    [roles.get(13).needsOutreach, roles.get(13).outreachUrgency],
    [false, ""],
  );
});

test("records outreach sent once and exposes its latest date", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "career-ops-dashboard-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  await mkdir(dataDir);

  const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 14 | 2026-07-20 | Acme | Engineering Manager | 4.5/5 | Applied | ✅ | — | Applied 2026-07-20. |
`;
  await writeFile(path.join(dataDir, "applications.md"), tracker);

  assert.deepEqual(
    await markApplicationOutreachSent(tempRoot, 14, { date: "2026-07-27" }),
    { outreachSent: true, lastOutreachDate: "2026-07-27", changed: true },
  );
  assert.deepEqual(
    await markApplicationOutreachSent(tempRoot, 14, { date: "2026-07-28" }),
    { outreachSent: true, lastOutreachDate: "2026-07-27", changed: false },
  );

  const history = await readFile(path.join(dataDir, "follow-ups.md"), "utf8");
  assert.match(
    history,
    /\| 1 \| 14 \| 2026-07-27 \| Acme \| Engineering Manager \| Outreach \| — \| Marked sent from dashboard \|/,
  );
  assert.equal(history.match(/\| 1 \| 14 \|/g)?.length, 1);

  const applications = await loadCompanyApplications(tempRoot, {
    now: new Date("2026-07-28T12:00:00Z"),
  });
  const role = applications.companies[0].roles[0];
  assert.equal(role.outreachSent, true);
  assert.equal(role.lastOutreachDate, "2026-07-27");
  assert.equal(role.needsOutreach, false);
  assert.equal(role.appliedDate, "2026-07-20");
});

test("reads the posted band out of a report summary table", () => {
  assert.deepEqual(
    parseCompBand("| **Comp** | $225,000–$260,000 base, plus equity |"),
    { min: 225000, max: 260000 },
  );
  assert.deepEqual(parseCompBand("| Comp | **$220,000 - $275,000 annually** (posted) |"), { min: 220000, max: 275000 });
  assert.deepEqual(parseCompBand("| **Comp posted** | $200K–$250K annual US base |"), { min: 200000, max: 250000 });
  assert.deepEqual(parseCompBand("| Compensation signal | $184,000 - $276,000 USD |"), { min: 184000, max: 276000 });
  assert.deepEqual(parseCompBand("| Job posting (Ashby) | USA: $190,000-$278,000 base; Canada: $171,000-$248,000 CAD |", {
    country: "United States",
    state: "GA",
  }), { min: 190000, max: 278000 });
  assert.deepEqual(parseCompBand("| Compensation signal | WA $265,000-$279,500; All other states $221,000-$233,000 |", {
    country: "United States",
    state: "GA",
  }), { min: 221000, max: 233000 });
  assert.deepEqual(parseCompBand("| Compensation signal | GA: $230,000-$260,000; All other states: $200,000-$220,000 |", {
    country: "United States",
    state: "GA",
  }), { min: 230000, max: 260000 });
  assert.deepEqual(parseCompBand("| Posted range | Zone A: $155,000-$248,000; Zone B: $135,000-$216,000; Zone C: $122,000-$195,000 |"), {
    min: null,
    max: null,
    ranges: [
      { min: 155000, max: 248000 },
      { min: 135000, max: 216000 },
      { min: 122000, max: 195000 },
    ],
  });
  assert.deepEqual(parseCompBand("| Comp (stated) | $205,000 — single point, not a range |"), { min: 205000, max: 205000 });
  assert.deepEqual(parseCompBand("Per the JD: the range is $436,000-$710,000, above the candidate target."), { min: 436000, max: 710000 });
  assert.deepEqual(parseCompBand("| Comp | Not disclosed |"), { min: null, max: null });
  assert.deepEqual(parseCompBand(`
| **Comp posted** | **None.** Pay transparency is available in qualifying jurisdictions |
| Humata IC comp signal | Humata SWE I / SWE II listings show **$120K-$140K** (unverified) |
| Market rate | Remote EM market is **$145K-$245K** |
`), { min: null, max: null });
  assert.deepEqual(parseCompBand("| Humata IC comp signal | $120K-$140K (unverified) |"), { min: null, max: null });
  assert.deepEqual(parseCompBand("no table here"), { min: null, max: null });
});

test("recommends asking from the midpoint to the top of the employer band", () => {
  // Never the bottom of their band, which is what the retired fixed bracket did.
  assert.deepEqual(recommendAsk({ min: 225000, max: 260000 }, 200000), {
    askMin: 242500, askMax: 260000, note: "", belowFloor: false,
  });
  // Their midpoint sits under the walk-away floor, so open at the floor.
  assert.deepEqual(recommendAsk({ min: 150000, max: 230000 }, 200000), {
    askMin: 200000, askMax: 230000, note: "", belowFloor: false,
  });
  // Whole band under the floor is a warning, not a number to type.
  assert.equal(recommendAsk({ min: 120000, max: 180000 }, 200000).belowFloor, true);
  assert.equal(recommendAsk({ min: null, max: null }, 200000).note, "No published band — ask the recruiter before entering a number");
  assert.equal(
    recommendAsk({ min: null, max: null, ranges: [{ min: 150000, max: 200000 }, { min: 180000, max: 230000 }] }, 200000).note,
    "Multiple location bands — verify which one applies before answering",
  );
  assert.deepEqual(
    recommendAsk({ min: null, max: null }, 200000, { min: 250000, max: 300000 }),
    {
      askMin: 250000,
      askMax: 300000,
      note: "Your target range — employer did not publish a band",
      belowFloor: false,
    },
  );
  assert.deepEqual(
    recommendAsk({ min: 120000, max: 180000 }, 200000, { min: 250000, max: 300000 }),
    {
      askMin: 250000,
      askMax: 300000,
      note: "Your target range — employer's whole band is under your floor",
      belowFloor: true,
    },
  );
});
