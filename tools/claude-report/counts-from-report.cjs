#!/usr/bin/env node
// Add the real counts to a stored report that has no saved collection, by reading them from the report's own tables.
//   node counts-from-report.cjs <report.html> [--yes]
// For reports made before counts were kept AND before raw collections were saved (7-13 Sep, 21-27 Sep). It reads:
//   Section 04 LLM Visibility  -> mentions (the org's total, all assistants and questions)
//   Section 05 Social Media    -> posts per platform (LinkedIn, X, Instagram, YouTube videos)
//   Section 01a Press          -> articles on the five print outlets
//   Section 01b TV             -> articles on the five TV channels
// and ADDS tv, print, mentions, li, x, ig, yt to reports/<name>.json. Nothing already there is changed. Every row is checked
// (the platform counts must add up to the table's Total, the organisation totals to the Cohort row, the articles must equal
// the ones already stored); if anything does not add up nothing is written. Without --yes it only prints.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REPO, positional } = require("./lib.cjs");

const file = positional()[0];
if (!file) { console.error("usage: node counts-from-report.cjs <report.html> [--yes]"); process.exit(1); }
const yes = process.argv.includes("--yes");
const html = fs.readFileSync(file, "utf8");
const fail = (m) => { console.error("NOT WRITTEN: " + m); process.exit(1); };

const section = (id) => {
  const m = new RegExp(`<section[^>]*id="${id}"`).exec(html);
  if (!m) fail(`the report has no section "${id}"`);
  const rest = html.slice(m.index + m[0].length), n = /<section/.exec(rest);
  return html.slice(m.index, m.index + m[0].length + (n ? n.index : rest.length));
};
const text = (x) => x.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&middot;|&rarr;|&mdash;|&#9432;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const gh = (args, opts = {}) => execFileSync("gh", args, { maxBuffer: 1 << 28, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"], ...opts });
const period = /Period: (\d{4}-\d\d-\d\d)\D{1,15}(\d{4}-\d\d-\d\d)/.exec(text(html));
if (!period) fail("could not read the report's period");
const [, from, to] = period;

const reports = JSON.parse(gh(["api", `repos/${REPO}/contents/reports`]).toString()).filter((f) => /\.json$/.test(f.name));
let target = null, stored = null;
for (const f of reports) {
  const j = JSON.parse(Buffer.from(JSON.parse(gh(["api", `repos/${REPO}/contents/${f.path}`]).toString()).content, "base64").toString("utf8"));
  if (j.dateFrom === from && j.dateTo === to && /-Full-/.test(f.name)) { target = f; stored = j; break; }
}
if (!target) fail(`no stored full report for ${from} to ${to}`);
const orgs = stored.orgs;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const after = (t, org, re) => { const m = new RegExp(`(?:^|[^A-Za-z])${esc(org)} ${re}`).exec(t); return m; };

// LLM mentions: "<org> <total> a/15 b/15 c/15"
const aeoT = text(section("aeo"));
const mentions = {};
for (const o of orgs) {
  const m = after(aeoT.slice(aeoT.indexOf("Rank Org Total")), o, "(\\d+) \\d+/\\d+ \\d+/\\d+ \\d+/\\d+");
  if (!m) fail(`no LLM row for ${o}`);
  mentions[o] = +m[1];
}
const cohortM = /Cohort (\d+) \d+ \d+ \d+/.exec(aeoT.slice(aeoT.indexOf("Rank Org Total")));
if (!cohortM || Object.values(mentions).reduce((a, b) => a + b, 0) !== +cohortM[1]) fail("LLM mentions do not add up to the Cohort row");

// Social: "<org> LI ER flw X ER flw IG ER flw YT ER subs Total SoV%"
const socT = text(section("social"));
const tok = "(\\S+)";
const posts = {};
for (const o of orgs) {
  const m = after(socT.slice(socT.indexOf("# Org LI posts")), o, `${Array(14).fill(tok).join(" ")}`);
  if (!m) fail(`no social row for ${o}`);
  const n = (s) => (/^\d+$/.test(s) ? +s : 0); // ✕ / – = no channel for that platform
  const r = { li: n(m[1]), x: n(m[4]), ig: n(m[7]), yt: n(m[10]) };
  if (r.li + r.x + r.ig + r.yt !== +m[13]) fail(`social row for ${o} does not add up (${JSON.stringify(r)} vs total ${m[13]})`);
  posts[o] = r;
}
const coh = /COHORT (\d+) \S+ \S+ (\d+) \S+ \S+ (\d+) \S+ \S+ (\d+)/.exec(socT);
const sums = ["li", "x", "ig", "yt"].map((k) => orgs.reduce((a, o) => a + posts[o][k], 0));
if (!coh || [1, 2, 3, 4].some((i, j) => +coh[i] !== sums[j])) fail("posts do not add up to the COHORT row");

// Articles on the print outlets / TV channels: "<org> <total> ..." in the two outlet tables
const pressT = text(section("sov"));
const printStart = pressT.indexOf("Print / Online Org Total"), tvStart = pressT.indexOf("English TV Org Total");
const printT = pressT.slice(printStart, tvStart > printStart ? tvStart : undefined);
const print = {};
for (const o of orgs) { const m = after(printT, o, "(\\d+)"); if (!m) fail(`no print row for ${o}`); print[o] = +m[1]; }
const tvT = text(section("tv"));
const tv = {};
for (const o of orgs) {
  const eng = after(tvT.slice(tvT.indexOf("English TV Org Total"), tvT.indexOf("Hindi TV Org Total")), o, "(\\d+)");
  const hin = after(tvT.slice(tvT.indexOf("Hindi TV Org Total")), o, "(\\d+)");
  if (!eng || !hin) fail(`no TV row for ${o}`);
  tv[o] = +eng[1] + +hin[1];
}
for (const o of orgs) if (tv[o] + print[o] > stored.scores[o].articles) fail(`${o}: ${tv[o]} TV + ${print[o]} print articles is more than the ${stored.scores[o].articles} stored`);

const merged = { ...stored, scores: Object.fromEntries(orgs.map((o) => [o, { ...stored.scores[o], tv: tv[o], print: print[o], mentions: mentions[o], ...posts[o] }])) };
console.log(`${target.name} (${from} to ${to}):`);
for (const o of orgs) console.log(`  ${o}: TV ${tv[o]}, print ${print[o]}, LLM mentions ${mentions[o]}, posts LI ${posts[o].li} X ${posts[o].x} IG ${posts[o].ig} YT ${posts[o].yt}`);
if (!yes) { console.log("\nDry run. Add --yes to write."); process.exit(0); }
gh(["api", "-X", "PUT", `repos/${REPO}/contents/${target.path}`, "--input", "-"], { input: JSON.stringify({ message: `Add counts to ${target.name}, read from the report's own tables`, content: Buffer.from(JSON.stringify(merged)).toString("base64"), branch: "main", sha: target.sha }) });
console.log("\nWritten.");
