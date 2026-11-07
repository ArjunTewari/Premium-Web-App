#!/usr/bin/env node
// Add the real counts (TV / print articles, LLM mentions, posts per platform) to reports already in the web app.
//   node add-counts.cjs [--reviews dir-of-review.json-files] [--yes]
// The Trends tab plots counts, not scores. Reports built before the counts were stored have only scores, so this reads the
// saved collection of each week (raw/CHK-….json.gz in the reports repo), works the figures out again with the same code the
// report was built with, and ADDS the new fields to reports/<name>.json. Nothing already there is changed.
//
// Safety: a report is touched only when the figures worked out again (articles, AI-visibility score, social-presence score)
// equal the ones stored for EVERY organisation. If they differ (for example because posts were left out of the published
// report) each review file given with --reviews is tried; if none reproduces the stored figures the report is skipped and
// listed. Without --yes nothing is written.
process.env.KEEP_ALL_POSTS = "1";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const L = require("./lib.cjs");
L.useAppModules();

const yes = process.argv.includes("--yes");
const reviewDir = L.arg("reviews");
const gh = (args, opts = {}) => execFileSync("gh", args, { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
const api = (p) => JSON.parse(gh(["api", `repos/${L.REPO}/${p}`]).toString());
const NEW = ["tv", "print", "mentions", "li", "x", "ig", "yt"];

L.stubClaude(async (p) => {
  if (/Write 3 comparative findings/.test(p)) return JSON.stringify([1, 2, 3].map(() => ({ headline: "x", detail: "x", section_ref: "§03 AQ Press Analytics" })));
  const m = /Generate exactly 4 strategic actions for "([^"]+)"/.exec(p);
  if (m) return JSON.stringify([1, 2, 3, 4].map(() => ({ org: m[1], priority: "Optimise", area: "Social", action: "x", rationale: "x" })));
  throw new Error("not available");
});
const Audit = L.pipe("audit.js");
Audit.runAudit = async () => ({ passed: true, errors: [], warnings: [], checks: 0, review: { ran: true, verdict: "pass", model: "backfill", findings: [] }, summary: "" });

const same = (stored, fresh, withSocial = true) => Object.keys(stored.scores).every((o) => {
  const a = stored.scores[o], b = fresh.scores[o];
  return b && a.articles === b.articles && a.aeo === b.aeo && (!withSocial || a.social === b.social);
});
const NEWS_AND_AI = ["tv", "print", "mentions"];

async function figures(chk, exclude) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-counts-"));
  const P = L.pipe("pipeline.js");
  const r = await P.run(L.configFromCheckpoint(chk, { outDir: tmp, excludePosts: exclude }), () => {});
  return r.trendSummary;
}

(async () => {
  const CP = L.pipe("checkpoint.js");
  const reports = api("contents/reports").filter((f) => /\.json$/.test(f.name));
  const raws = api("contents/raw").filter((f) => /\.json\.gz$/.test(f.name));
  const excludeSets = [null];
  if (reviewDir) for (const f of fs.readdirSync(reviewDir).filter((f) => /\.json$/.test(f))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(reviewDir, f), "utf8")); if (Array.isArray(j.excludePosts)) excludeSets.push({ from: f, urls: j.excludePosts }); } catch { /* not a review file */ }
  }
  const chks = raws.map((f) => ({ name: f.name, chk: CP.unpack(gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${L.REPO}/contents/${f.path}`]) ) }));

  for (const f of reports) {
    const stored = JSON.parse(Buffer.from(api(`contents/${f.path}`).content, "base64").toString("utf8"));
    if (!stored.scores) continue;
    if (Object.values(stored.scores).every((s) => NEW.every((k) => k in s))) { console.log(`${f.name}: already has the counts`); continue; }
    const cands = chks.filter((c) => c.chk.fingerprint.dateFrom === stored.dateFrom && c.chk.fingerprint.dateTo === stored.dateTo && c.chk.fingerprint.orgs.length === (stored.orgs || []).length);
    if (!cands.length) { console.log(`${f.name}: no saved collection for ${stored.dateFrom} to ${stored.dateTo} — skipped`); continue; }
    let hit = null;
    for (const c of cands) {
      for (const ex of excludeSets) {
        let fresh;
        try { fresh = await figures(c.chk, ex ? ex.urls : (c.chk.state.excludePosts || [])); } catch (e) { continue; }
        if (same(stored, fresh)) { hit = { fresh, c, ex }; break; }
      }
      if (hit) break;
    }
    let keys = NEW;
    if (!hit) {
      // The articles and the AI-visibility score reproduce but the social-presence score does not (the published report counted
      // posts under older rules): add the news and AI counts, leave the post counts out rather than guess.
      for (const c of cands) {
        let fresh;
        try { fresh = await figures(c.chk, c.chk.state.excludePosts || []); } catch (e) { continue; }
        if (same(stored, fresh, false)) { hit = { fresh, c, ex: null }; keys = NEWS_AND_AI; break; }
      }
    }
    if (!hit) { console.log(`${f.name}: the saved collection does not reproduce the stored figures — skipped`); continue; }
    const merged = { ...stored, scores: Object.fromEntries(Object.entries(stored.scores).map(([o, s]) => [o, { ...s, ...Object.fromEntries(keys.map((k) => [k, hit.fresh.scores[o][k]])) }])) };
    console.log(`${f.name}: reproduced from ${hit.c.name}${hit.ex ? ` with ${hit.ex.from}` : ""} — adds ${keys.join(", ")} for ${Object.keys(merged.scores).length} organisations${keys === NEWS_AND_AI ? " (post counts NOT added: the published social-presence score does not reproduce)" : ""}`);
    if (!yes) continue;
    gh(["api", "-X", "PUT", `repos/${L.REPO}/contents/${f.path}`, "--input", "-"], { input: JSON.stringify({ message: `Add counts to ${f.name} (TV/print articles, LLM mentions, posts per platform)`, content: Buffer.from(JSON.stringify(merged)).toString("base64"), branch: "main", sha: f.sha }) });
  }
  if (!yes) console.log("\nDry run. Add --yes to write.");
})().catch((e) => { console.error(e.message || e); process.exit(1); });
