// Run: node tests/repair.test.cjs  (needs the app's node_modules). No network, no Claude.
// When the audit finds an error in the executive summary's TEXT, the summary is written again with what the
// reviewer found (then flagged findings are removed) and the report is audited again; an error in the DATA is not
// "repaired" by editing text; data saved before posts were kept is refused; "A and B each ..." is checked for both.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
const dir = path.join(__dirname, "..", "src", "pipeline");
const prompts = [];
let execVersion = 0;
const goodExec = [{ headline: "CREA recorded 2 articles", detail: "CREA recorded 2 articles at 100% data-specific coverage.", section_ref: "§03 AQ Press Analytics" }, { headline: "TERI recorded 1 article", detail: "TERI recorded 1 article.", section_ref: "§03 AQ Press Analytics" }, { headline: "Social presence", detail: "CREA recorded 4/10 social presence.", section_ref: "§Social Media" }];
const badExec = [{ headline: "Articles by organisation", detail: "CREA and TERI each published 1 article.", section_ref: "§03 AQ Press Analytics" }, goodExec[1], goodExec[2]];
const claudeStub = { askClaude: async (p) => {
  prompts.push(p);
  if (/Write 3 comparative findings/.test(p)) { execVersion++; return JSON.stringify(/independent reviewer found/.test(p) ? goodExec : badExec); }
  const m = /Generate exactly 4 strategic actions for "([^"]+)"/.exec(p);
  if (m) return JSON.stringify([1, 2, 3, 4].map((i) => ({ org: m[1], priority: "Optimise", area: "Social", action: `a${i}`, rationale: "r" })));
  throw new Error("stub"); }, usage: {}, ClaudeCliError: Error, resolveCli: () => ({}), childEnv: () => ({}) };
const orig = Module._load; Module._load = function (r, ...a) { return /(^|\/)claude-cli(\.js)?$/.test(r) ? claudeStub : orig.call(this, r, ...a); };
const Reviewer = require(path.join(dir, "claude-review.js"));
const P = require(path.join(dir, "pipeline.js")), CP = require(path.join(dir, "checkpoint.js")), A = require(path.join(dir, "audit.js")), Sentinel = require(path.join(dir, "sentinel.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

// ── "A and B each ..." ──
const data = { CREA: { total: 2, dataPct: 100, authPct: 0, aeo: 0, social: 4 }, TERI: { total: 1, dataPct: 100, authPct: 0, aeo: 0, social: 0 } };
let v = Sentinel.validateExecSummary([{ headline: "x", detail: "CREA and TERI each published 1 article at 100% data-specific content." }], data, ["CREA", "TERI"]);
eq("'CREA and TERI each published 1 article' is checked for both: CREA is wrong, TERI is right", [v.issues.length, v.issues[0] && v.issues[0].org, v.issues[0] && v.issues[0].correctedValue], [1, "CREA", null]);
v = Sentinel.validateExecSummary([{ headline: "x", detail: "CREA published 2 articles and TERI published 1 article." }], data, ["CREA", "TERI"]);
eq("a sentence that gives each organisation its own number is still checked one by one (no false issue)", v.issues.length, 0);

// ── which errors can be repaired ──
const sErr = { source: "review", severity: "error", org: "CREA", where: "CREA · executive summary ('Articles by organisation')", issue: "CREA published 2 articles, not 1" };
const dErr = { source: "review", severity: "error", org: "CREA", where: "CREA · X posts", issue: "off-topic posts counted" };
let plan = A.repairPlan([sErr], badExec);
eq("a summary-only error is repairable and names the finding", [plan.repairable, plan.flagged], [true, [0]]);
plan = A.repairPlan([sErr, dErr], badExec);
eq("an error about the data is not repairable by rewriting text", [plan.repairable, plan.other.length], [false, 1]);
plan = A.repairPlan([{ source: "rules", severity: "error", org: "CREA", where: "executive summary, finding 2", issue: "claims 5 articles" }], badExec);
eq("a rules error 'finding N' flags that finding", plan.flagged, [1]);

// ── data saved before posts were kept ──
const mkRes = (o) => ({ org: o, liData: { postCount: 0 }, twData: { postCount: 13 }, igData: { postCount: 0 } });
eq("data with counts but no saved posts is not re-countable", CP.recountable({ state: { socialERResults: [mkRes("A")] } }), false);
eq("data with saved posts is re-countable", CP.recountable({ state: { socialERResults: [{ ...mkRes("A"), twData: { postCount: 13, rawTweets: [] } }] } }), true);
eq("data in which nothing was counted has nothing stale", CP.recountable({ state: { socialERResults: [{ org: "A", liData: { postCount: 0 }, twData: { postCount: 0 }, igData: { postCount: 0 } }] } }), true);

// ── the repair loop, end to end ──
const ORGS = ["CREA", "TERI"];
const empty = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, followers: 0, er: 0, topPosts: [] };
const post = (i, t, k) => ({ url: `https://twitter.com/a/status/${i}`, snippet: t, keywords_found: k, likes: 7, replies: 1, retweets: 2, date: "2026-10-14" });
const social = [
  { org: "CREA", presenceScore: 4, liData: { ...empty }, twData: { ...empty, postCount: 2, totalLikes: 14, totalReplies: 2, totalRetweets: 4, totalViews: 0, followers: 5000, topPosts: [post(1, "PM2.5 in Delhi", ["pm2.5"]), post(2, "NCAP funding", ["ncap"])] }, igData: { ...empty }, ytChData: { subscribers: 0 } },
  { org: "TERI", presenceScore: 0, liData: { ...empty }, twData: { ...empty, totalReplies: 0, totalRetweets: 0, totalViews: 0 }, igData: { ...empty }, ytChData: { subscribers: 0 } },
];
const art = (t) => ({ title: t, url: "https://x/" + t, outlet: "The Hindu", date: "2026-10-14", snippet: "air quality " + t, fullText: "air quality " + t });
const aeo = { CREA: { mentions: 0, score: 0, llmBreakdown: {}, topResponse: "", questionResults: {} }, TERI: { mentions: 0, score: 0, llmBreakdown: {}, topResponse: "", questionResults: {} } };
const cls1 = (a) => ({ ...a, citation_quality: "Data Cited", aq_relevant: true, aq_subtopic: "General AQ", outlet: "The Hindu" });
const cpState = () => ({ arts: { CREA: [art("a1"), art("a2")].map(cls1), TERI: [art("t1")].map(cls1) }, cls: { CREA: [], TERI: [] }, exaWhiteSpace: [], aeoResults: aeo, aeoQueriesUsed: ["q?"], socialERResults: social, youtubeERResults: [] });
const fp = { framework: "air-quality", orgs: ORGS, dateFrom: "2026-10-12", dateTo: "2026-10-18", scopeKeywords: [], aeoQueries: [] };
const cfgFor = (out, chk) => ({ ORGS, DATE_FROM: fp.dateFrom, DATE_TO: fp.dateTo, CLIENT_NAME: "t", SCOPE_KEYWORDS: [], AEO_QUERIES: [], FRAMEWORK: "air-quality", CLAUDE_KEY: "claude-cli", outDir: out, resumeCheckpoint: chk });

(async () => {
  const chk = CP.unpack(CP.pack(fp, cpState(), {}));

  // reviewer fails once on the summary, then passes
  let reviews = 0;
  Reviewer.review = async () => { reviews++; return reviews === 1 ? { verdict: "fail", findings: [{ severity: "error", org: "CREA", where: "CREA · executive summary ('Articles by organisation')", issue: "CREA published 2 articles, not 1", evidence: "press.articles=2" }], model: "stub" } : { verdict: "pass", findings: [], model: "stub" }; };
  let out = fs.mkdtempSync(path.join(os.tmpdir(), "repair-"));
  const msgs = [];
  let r;
  try { r = await P.run(cfgFor(out, chk), (m) => msgs.push(m)); } catch (e) { msgs.push("ERR " + e.message.slice(0, 300)); }
  const repaired = msgs.some((m) => /repair round 1: the executive summary is written again/.test(m));
  const html = r ? fs.readFileSync(path.join(out, r.htmlName), "utf8") : "";
  eq("a summary error is repaired: summary written again, audited again, report written", [repaired, !!r, reviews, /emerald-audit" content="passed/.test(html)], [true, true, 2, true]);
  eq("the second summary request carried the reviewer's finding", prompts.some((p) => /Write 3 comparative findings/.test(p) && /independent reviewer found these problems/.test(p) && /CREA published 2 articles, not 1/.test(p)), true);
  eq("the report carries the corrected summary, not the wrong one", [/CREA and TERI each published 1 article/.test(html), /recorded 2 articles/.test(html)], [false, true]);

  // reviewer keeps naming the same finding: it is removed in round 2
  prompts.length = 0; execVersion = 0;
  const stillBad = badExec;
  const claude2 = claudeStub.askClaude;
  claudeStub.askClaude = async (p) => { if (/Write 3 comparative findings/.test(p)) { prompts.push(p); execVersion++; return JSON.stringify(stillBad); } return claude2(p); };
  reviews = 0;
  Reviewer.review = async (pack) => { reviews++; const has = (pack.executiveSummary || []).some((s) => /Articles by organisation/.test(s)); return has ? { verdict: "fail", findings: [{ severity: "error", org: "CREA", where: "CREA · executive summary ('Articles by organisation')", issue: "wrong", evidence: "x" }], model: "stub" } : { verdict: "pass", findings: [], model: "stub" }; };
  out = fs.mkdtempSync(path.join(os.tmpdir(), "repair2-")); const msgs2 = []; r = null;
  try { r = await P.run(cfgFor(out, chk), (m) => msgs2.push(m)); } catch (e) { msgs2.push("ERR " + e.message.slice(0, 300)); }
  const html2 = r ? fs.readFileSync(path.join(out, r.htmlName), "utf8") : "";
  // (here the rewrite itself still contains a number the data contradicts, which the summary step already removes;
  // either way the finding must be gone and the report written)
  eq("a finding that stays wrong after a rewrite does not reach the report, and the report is written", [!!r, /Articles by organisation/.test(html2), /CREA and TERI each published 1 article/.test(html2)], [true, false, false]);
  claudeStub.askClaude = claude2;

  // an error about the data is not repaired
  prompts.length = 0;
  Reviewer.review = async () => ({ verdict: "fail", findings: [{ severity: "error", org: "CREA", where: "CREA · X posts", issue: "an off-topic post is counted", evidence: "x" }], model: "stub" });
  out = fs.mkdtempSync(path.join(os.tmpdir(), "repair3-")); let err = "";
  try { await P.run(cfgFor(out, chk), () => {}); } catch (e) { err = e.message; }
  eq("a data error stops the report and no summary rewrite is attempted", [/AUDIT FAILED/.test(err), prompts.filter((p) => /independent reviewer found these problems/.test(p)).length], [true, 0]);

  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
