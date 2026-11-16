#!/usr/bin/env node
// Put several weekly collections side by side into ONE collection, so a 4-week (or longer) report can be built from data
// that is already saved — nothing is fetched, nothing is paid for again.
//   node merge-weeks.cjs <week1.json.gz> <week2.json.gz> ... --out <merged.json.gz>
//   (a file name that is not on disk is read from raw/ in the reports repo)
// The weeks must be the same framework and organisations, and follow one another with no gap and no overlap.
//
// What is put together:
//   articles            every week's articles, one per address (a story found in two weeks counts once); each article keeps
//                       its own classification
//   social posts        LinkedIn / X / Instagram: the saved posts of every week are pooled (one per address); the counts are
//                       then worked out again for the whole period by the app's own re-count when the report is built
//   YouTube             the videos of every week (one per video), figures worked out again with the app's own formulas
//   AI-assistant probes NOT put together: the questions differ from week to week and a score is a measurement on one day.
//                       The LATEST week's probes are used and the report is built with exactly those questions.
//   cost                added up (the saved data's own fetching cost belongs to the report)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib.cjs");
L.useAppModules();
const CP = L.pipe("checkpoint.js");

const out = L.arg("out");
const inputs = L.positional();
if (!out || inputs.length < 2) { console.error("usage: node merge-weeks.cjs <week1.json.gz> <week2.json.gz> ... --out <merged.json.gz>"); process.exit(1); }
const fail = (m) => { console.error("NOT MERGED: " + m); process.exit(1); };

const load = (f) => {
  if (fs.existsSync(f)) return CP.unpack(fs.readFileSync(f));
  const buf = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${L.REPO}/contents/raw/${f}`], { maxBuffer: 1 << 28 });
  return CP.unpack(buf);
};
const weeks = inputs.map(load).sort((a, b) => a.fingerprint.dateFrom.localeCompare(b.fingerprint.dateFrom));
const first = weeks[0], last = weeks[weeks.length - 1];
const orgs = first.fingerprint.orgs;

// ── the weeks must fit together ──
const day = (s) => new Date(`${s}T00:00:00Z`).getTime();
for (let i = 0; i < weeks.length; i++) {
  const fp = weeks[i].fingerprint;
  if (fp.framework !== first.fingerprint.framework) fail(`${fp.dateFrom}: a different framework (${fp.framework})`);
  if ([...fp.orgs].sort().join("|") !== [...orgs].sort().join("|")) fail(`${fp.dateFrom}: a different list of organisations`);
  if (i && day(fp.dateFrom) !== day(weeks[i - 1].fingerprint.dateTo) + 864e5) fail(`${weeks[i - 1].fingerprint.dateTo} to ${fp.dateFrom}: the weeks do not follow one another (a gap or an overlap)`);
}
// scope keywords: an empty list means the framework's own default, so only explicit lists are compared
const explicit = weeks.map((w) => w.fingerprint.scopeKeywords).filter((k) => k && k.length);
if (explicit.some((k) => k.join("|") !== explicit[0].join("|"))) fail("the weeks were collected with different scope keywords");
const scopeKeywords = explicit[0] || [];

const pick = (obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined);
const uniq = (lists, keyOf) => { const seen = new Set(), res = []; for (const l of lists) for (const x of l || []) { const k = keyOf(x); if (!seen.has(k)) { seen.add(k); res.push(x); } } return res; };

// ── articles and their classification ──
const arts = {}, cls = {};
for (const org of orgs) {
  arts[org] = []; cls[org] = [];
  const seen = new Set();
  for (const w of weeks) {
    const a = w.state.arts[org] || [], k = w.state.cls[org] || [];
    a.forEach((art, i) => {
      const key = art.url || `${art.title}|${art.date}`;
      if (seen.has(key)) return;
      seen.add(key);
      const n = arts[org].length;
      arts[org].push(art);
      const c = k.find((x) => x.index === i);
      if (c) cls[org].push({ ...c, index: n });
    });
  }
}
const exaWhiteSpace = uniq(weeks.map((w) => w.state.exaWhiteSpace), (a) => a.url || a.title);

// ── social: pool the saved posts, newest collection's other figures (they are worked out again) ──
const mergePlatform = (entries, poolKey, metaFlags) => {
  const have = entries.filter((e) => e && Array.isArray(e[poolKey]));
  if (!have.length) return entries[entries.length - 1];
  const base = { ...have[have.length - 1] }; // the latest collection
  base[poolKey] = uniq(have.map((e) => e[poolKey]), (p) => p.url || p.id || `${p.date}|${(p.text || p.snippet || "").slice(0, 80)}`);
  base.rawMeta = { ...(base.rawMeta || {}) };
  for (const f of metaFlags) base.rawMeta[f] = have.some((e) => e.rawMeta && e.rawMeta[f]);
  return base;
};
const socialERResults = orgs.map((org) => {
  const rows = weeks.map((w) => w.state.socialERResults.find((r) => r.org === org)).filter(Boolean);
  const latest = rows[rows.length - 1] || { org };
  return {
    ...latest,
    liData: mergePlatform(rows.map((r) => r.liData), "rawPosts", ["capHit"]),
    twData: mergePlatform(rows.map((r) => r.twData), "rawTweets", ["timelineCapHit", "searchCapHit"]),
    igData: mergePlatform(rows.map((r) => r.igData), "rawPosts", []),
  };
});

// ── YouTube: the videos of every week, figures as the app works them out ──
const inWindow = (d) => { const t = String(d || "").slice(0, 10); return t >= first.fingerprint.dateFrom && t <= last.fingerprint.dateTo; };
const youtubeERResults = orgs.map((org) => {
  const rows = weeks.map((w) => w.state.youtubeERResults.find((r) => r.org === org)).filter(Boolean);
  const latest = rows[rows.length - 1] || { org };
  const videos = uniq(rows.map((r) => r.videos), (v) => v.videoId).filter((v) => inWindow(v.publishedAt));
  const subER = videos.filter((v) => v.subscriberER !== null && v.subscriberER !== undefined), viewER = videos.filter((v) => v.viewER !== null && v.viewER !== undefined);
  const mean = (xs, f) => (xs.length ? parseFloat((xs.reduce((s, v) => s + Number(f(v)), 0) / xs.length).toFixed(3)) : 0);
  const sum = (f) => videos.reduce((s, v) => s + (Number(f(v)) || 0), 0);
  return {
    ...latest, org, videos, videoCount: videos.length,
    avgER: mean(subER, (v) => v.subscriberER), avgViewER: mean(viewER, (v) => v.viewER),
    erMethod: subER.length ? "subscriber" : viewER.length ? "view" : "none",
    totalViews: sum((v) => v.views), totalLikes: sum((v) => v.likes), totalComments: sum((v) => v.comments),
    discovered: rows.reduce((s, r) => s + (r.discovered || 0), 0), truncated: rows.some((r) => r.truncated),
    failed: rows.length > 0 && rows.every((r) => r.failed),
  };
});
youtubeERResults.sort((a, b) => (b.avgER - a.avgER) || (b.avgViewER - a.avgViewER) || (b.videoCount - a.videoCount));
youtubeERResults.forEach((r, i) => { r.rank = i + 1; });

// ── AI-assistant probes: the latest week's, with its own questions ──
const aeoResults = last.state.aeoResults, aeoQueriesUsed = last.state.aeoQueriesUsed;

const cost = {};
for (const w of weeks) for (const [k, v] of Object.entries(w.cost || {})) if (typeof v === "number") cost[k] = (cost[k] || 0) + v;

const fp = { framework: first.fingerprint.framework, orgs, dateFrom: first.fingerprint.dateFrom, dateTo: last.fingerprint.dateTo, scopeKeywords, aeoQueries: aeoQueriesUsed };
fs.writeFileSync(out, CP.pack(fp, { arts, cls, exaWhiteSpace, aeoResults, aeoQueriesUsed, socialERResults, youtubeERResults }, cost));

const n = (f) => orgs.reduce((s, o) => s + f(o), 0);
console.log(`merged ${weeks.length} weeks, ${fp.dateFrom} to ${fp.dateTo}, ${orgs.length} organisations → ${out}`);
console.log(`  articles ${n((o) => arts[o].length)} (the weeks had ${weeks.map((w) => orgs.reduce((s, o) => s + (w.state.arts[o] || []).length, 0)).join(" + ")})`);
console.log(`  AI-assistant probes from the week of ${last.fingerprint.dateFrom} (${aeoQueriesUsed.length} questions, saved ${last.savedAt})`);
