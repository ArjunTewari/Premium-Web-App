#!/usr/bin/env node
// Step 2 — read the collected data. Nothing is fetched, nothing is written outside --out.
//   node digest.cjs <checkpoint.json.gz> [--review review.json] [--out dir]  (default ./work/digest)
// With --review, the posts listed in its excludePosts are left out first, so the figures are the ones the report will show.
// Writes:
//   summary-prompt.txt   the figures and FACTS lines the executive summary and actions must be written from
//   posts-to-review.md   EVERY counted post, with the words that matched, grouped by organisation and platform
//   evidence-pack.json   what the independent reviewer is shown
//   audit-warnings.txt   the rule checks' warnings and errors on the data as it stands
process.env.KEEP_ALL_POSTS = "1"; // list every counted post, not only the top 5 of X / Instagram
const fs = require("fs");
const path = require("path");
const L = require("./lib.cjs");
L.useAppModules();

const file = L.positional()[0];
if (!file) { console.error("usage: node digest.cjs <checkpoint.json.gz> [--out dir]"); process.exit(1); }
const out = path.resolve(L.arg("out", path.join("work", "digest")));
fs.mkdirSync(out, { recursive: true });

let execPrompt = "";
const placeholder = (org) => [1, 2, 3, 4].map((i) => ({ org, priority: "Optimise", area: "Social", action: `placeholder ${i}`, rationale: "placeholder" }));
L.stubClaude(async (p) => {
  if (/Write 3 comparative findings/.test(p)) {
    execPrompt = execPrompt || p;
    return JSON.stringify([1, 2, 3].map((i) => ({ headline: "placeholder", detail: "placeholder", section_ref: "§03 AQ Press Analytics" })));
  }
  const m = /Generate exactly 4 strategic actions for "([^"]+)"/.exec(p);
  if (m) return JSON.stringify(placeholder(m[1]));
  throw new Error("not available");
});

const Audit = L.pipe("audit.js");
let ctxSeen = null;
// Capture the audit's inputs instead of auditing: this run only reads the data.
Audit.runAudit = async (ctx) => {
  ctxSeen = ctx;
  return { passed: true, errors: [], warnings: [], checks: 0, review: { ran: true, verdict: "pass", model: "digest", findings: [] }, summary: "" };
};

(async () => {
  const CP = L.pipe("checkpoint.js"), P = L.pipe("pipeline.js");
  const chk = CP.unpack(fs.readFileSync(file));
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "cc-digest-"));
  const exclude = L.arg("review") ? (JSON.parse(fs.readFileSync(L.arg("review"), "utf8")).excludePosts || []) : (chk.state.excludePosts || []);
  const cfg = L.configFromCheckpoint(chk, { outDir: tmp, excludePosts: exclude });
  const log = [];
  try { await P.run(cfg, (m) => log.push(m)); } catch (e) { console.error("digest run stopped:", e.message.slice(0, 400)); }
  if (!ctxSeen) { console.error("the data could not be read — see the log above"); console.error(log.slice(-15).join("\n")); process.exit(1); }

  const det = Audit.checkDeterministic(ctxSeen);
  const pack = Audit.buildEvidencePack(ctxSeen);
  fs.writeFileSync(path.join(out, "evidence-pack.json"), JSON.stringify(pack, null, 1));
  fs.writeFileSync(path.join(out, "summary-prompt.txt"), execPrompt);
  fs.writeFileSync(path.join(out, "audit-warnings.txt"),
    [...det.errors.map((e) => `ERROR  ${e.org} · ${e.where}: ${e.issue}`), ...det.warnings.map((w) => `warn   ${w.org} · ${w.where}: ${w.issue}`)].join("\n") + "\n");

  // every counted post, for reading
  let n = 0; const lines = [`# Counted posts — ${chk.fingerprint.dateFrom} to ${chk.fingerprint.dateTo}`, "",
    "Read every post. For each: is the post itself about the subject, or does it only contain a keyword by accident (a list of names, a link, an unrelated use of the word)?", ""];
  for (const o of pack.organisations) {
    for (const [pl, d] of Object.entries({ linkedin: o.social.linkedin, x: o.social.x, instagram: o.social.instagram })) {
      if (!d || !d.collected || !(d.topPosts || []).length) continue;
      lines.push(`## ${o.org} · ${pl} · ${d.posts} counted`);
      for (const t of d.topPosts) {
        n++;
        const ex = (t.matchExcerpts || [])[0];
        lines.push(`- ${t.url}  [${t.date || ""}]  keywords: ${(t.keywordsMatched || []).join(", ")}`,
          `    text: ${t.text}`, ex ? `    around "${ex.keyword}": ${ex.excerpt}` : "    (no excerpt found)");
      }
      lines.push("");
    }
  }
  fs.writeFileSync(path.join(out, "posts-to-review.md"), lines.join("\n"));
  const total = pack.organisations.reduce((s, o) => s + ["linkedin", "x", "instagram"].reduce((a, k) => a + ((o.social[k] && o.social[k].posts) || 0), 0), 0);
  console.log(`period ${chk.fingerprint.dateFrom} → ${chk.fingerprint.dateTo}, ${chk.fingerprint.orgs.length} organisations`);
  console.log(`counted posts: ${total} (listed for reading: ${n})`);
  console.log(`rule checks on the data: ${det.errors.length} error(s), ${det.warnings.length} warning(s)`);
  console.log(`written to ${out}`);
  fs.writeFileSync(path.join(out, "counted-posts.txt"), String(total));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(2); });
