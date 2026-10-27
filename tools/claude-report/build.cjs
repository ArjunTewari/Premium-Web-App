#!/usr/bin/env node
// Step 3 — build the report from the collected data and the text Claude Code wrote.
//   node build.cjs <checkpoint.json.gz> --text text.json --review review.json [--out dir]
//
// text.json    { "exec": [3 × {headline, detail, section_ref}], "actions": { "<org>": [4 × {priority, area, action, rationale}] } }
// review.json  { "reviewer": "Claude Code", "postsRead": <number of counted posts read in posts-to-review.md>,
//                "postsNotAvailable": <optional: counted posts whose text is not in the saved data, with the reason in notes>,
//                "excludePosts": [urls of counted posts that are not about the subject], "notes": "what was checked" }
//
// The rule checks (totals, shares, repeats, summary numbers vs data) run for real. The independent review is the
// review.json: the build refuses it unless postsRead equals the number of posts the report counts, and the report's
// audit stamp says it was a Claude Code review, how many posts were read and how many were left out.
const fs = require("fs");
const path = require("path");
const L = require("./lib.cjs");
L.useAppModules();

const [chkFile] = L.positional();
const textFile = L.arg("text"), reviewFile = L.arg("review");
if (!chkFile || !textFile || !reviewFile) { console.error("usage: node build.cjs <checkpoint.json.gz> --text text.json --review review.json [--out dir]"); process.exit(1); }
const out = path.resolve(L.arg("out", path.join("work", "report")));
fs.mkdirSync(out, { recursive: true });

const text = JSON.parse(fs.readFileSync(textFile, "utf8"));
const review = JSON.parse(fs.readFileSync(reviewFile, "utf8"));

const CP = L.pipe("checkpoint.js");
const chk = CP.unpack(fs.readFileSync(chkFile));
const fp = chk.fingerprint;

// ── the text must be complete before anything runs ──
const bad = [];
if (!Array.isArray(text.exec) || text.exec.length !== 3 || text.exec.some((f) => !f.headline || !f.detail || !f.section_ref)) bad.push("text.exec must be 3 findings with headline, detail, section_ref");
for (const org of fp.orgs) {
  const a = text.actions && text.actions[org];
  if (!Array.isArray(a) || a.length !== 4 || a.some((x) => !x.priority || !x.area || !x.action || !x.rationale)) bad.push(`text.actions["${org}"] must be 4 actions with priority, area, action, rationale`);
}
if (!review.reviewer || !Number.isInteger(review.postsRead) || !Array.isArray(review.excludePosts || [])) bad.push("review.json needs reviewer, postsRead (a number) and excludePosts (a list)");
if (bad.length) { console.error("NOT BUILT:\n- " + bad.join("\n- ")); process.exit(1); }

L.stubClaude(async (p) => {
  if (/Write 3 comparative findings/.test(p)) return JSON.stringify(text.exec);
  const m = /Generate exactly 4 strategic actions for "([^"]+)"/.exec(p);
  if (m && text.actions[m[1]]) return JSON.stringify(text.actions[m[1]].map((a) => ({ org: m[1], ...a })));
  throw new Error("this step is not available in the Claude Code workflow");
});

// The review: accepted only if it accounts for every counted post.
const Rev = L.pipe("claude-review.js");
let reviewProblem = "";
Rev.review = async (pack) => {
  const counted = pack.organisations.reduce((s, o) => s + ["linkedin", "x", "instagram"].reduce((a, k) => a + ((o.social[k] && o.social[k].posts) || 0), 0), 0);
  const na = review.postsNotAvailable || 0;
  const expected = counted + (review.excludePosts || []).length;
  if (review.postsRead + na !== expected) {
    reviewProblem = `the review accounts for ${review.postsRead} posts read + ${na} not available, but the report counts ${counted} and ${(review.excludePosts || []).length} were left out (${expected} in all). Read the full list again (digest.cjs) and fix postsRead.`;
    return { verdict: "fail", findings: [{ severity: "error", org: "(report)", where: "review", issue: reviewProblem, evidence: "" }], model: "Claude Code review" };
  }
  return { verdict: "pass", findings: [], model: `${review.reviewer} review of the evidence (${review.postsRead} posts read, ${(review.excludePosts || []).length} left out${na ? `, ${na} counted post(s) not readable in the saved data` : ""}); not the Claude CLI reviewer` };
};

const P = L.pipe("pipeline.js");
const cfg = L.configFromCheckpoint(chk, { outDir: out, excludePosts: review.excludePosts || [] });
const lines = [];
P.run(cfg, (m) => lines.push(m))
  .then((r) => {
    fs.writeFileSync(path.join(out, "trend.json"), JSON.stringify(r.trendSummary, null, 2));
    console.log(lines.filter((m) => /AUDIT|SENTINEL|Social figures|RESUMED|Action matrix|excluded:/.test(m)).join("\n"));
    console.log(`\nBUILT ${path.join(out, r.htmlName)}`);
    console.log(`trend data ${path.join(out, "trend.json")}`);
  })
  .catch((e) => {
    console.log(lines.filter((m) => /AUDIT|SENTINEL|✗|!.*review/.test(m)).slice(-40).join("\n"));
    console.error("\nNOT BUILT:", reviewProblem || e.message.slice(0, 1500));
    process.exit(1);
  });
