// Run: node tests/summary-facts.test.cjs  (needs the app's node_modules). No network, no Claude.
// The summary is given complete lists and marks for cells that were not collected, so it cannot list some
// organisations at 0/10 and omit others (26 Oct) or present a failed cell as a measured zero.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
const dir = path.join(__dirname, "..", "src", "pipeline");
const prompts = [];
const claudeStub = { askClaude: async (p) => { prompts.push(p); if (/independent auditor/.test(p)) return '{"verdict":"pass","findings":[]}'; throw new Error("stub"); }, usage: {}, ClaudeCliError: Error, resolveCli: () => ({}), childEnv: () => ({}) };
const orig = Module._load; Module._load = function (r, ...a) { return /(^|\/)claude-cli(\.js)?$/.test(r) ? claudeStub : orig.call(this, r, ...a); };
const P = require(path.join(dir, "pipeline.js")), CP = require(path.join(dir, "checkpoint.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };
const empty = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, followers: 0, er: 0, topPosts: [] };
const mk = (org, extra = {}) => ({ org, presenceScore: 0, liData: { ...empty, ...(extra.li || {}) }, twData: { ...empty, totalReplies: 0, totalRetweets: 0, totalViews: 0, ...(extra.tw || {}) }, igData: { ...empty, ...(extra.ig || {}) }, ytChData: { subscribers: 0 } });
const ORGS = ["Org A", "Org B", "Org C", "Org D"];
const social = [
  mk("Org A", { li: { postCount: 2, totalLikes: 10, topPosts: [{ url: "u1", snippet: "air quality", keywords_found: ["air quality"], likes: 10 }] } }),
  mk("Org B", { ig: { failed: true } }),
  mk("Org C", { li: { noHandle: true } }),
  mk("Org D"),
];
social[0].presenceScore = 4;
const aeo = (m) => ({ mentions: m, score: m, llmBreakdown: {}, topResponse: "", questionResults: {} });
const cp = { arts: Object.fromEntries(ORGS.map((o) => [o, []])), cls: Object.fromEntries(ORGS.map((o) => [o, []])), exaWhiteSpace: [], aeoResults: { "Org A": aeo(5), "Org B": aeo(0), "Org C": aeo(0), "Org D": aeo(0) }, aeoQueriesUsed: ["q?"], socialERResults: social, youtubeERResults: [] };
const fp = Object.freeze({ framework: "air-quality", orgs: ORGS, dateFrom: "2026-10-19", dateTo: "2026-10-25", scopeKeywords: [], aeoQueries: [] });
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-"));
(async () => {
  const chk = CP.unpack(CP.pack(fp, cp, {}));
  try { await P.run({ ORGS, DATE_FROM: "2026-10-19", DATE_TO: "2026-10-25", CLIENT_NAME: "t", SCOPE_KEYWORDS: [], AEO_QUERIES: [], FRAMEWORK: "air-quality", CLAUDE_KEY: "claude-cli", outDir, resumeCheckpoint: chk }, () => {}); } catch (e) { /* the audit may stop this toy report; only the prompt matters here */ }
  const exec = prompts.find((p) => /Write 3 comparative findings/.test(p)) || "";
  eq("the summary prompt carries complete lists", [/Organisations with 0 articles \(4\): Org A, Org B, Org C, Org D/.test(exec), /Organisations with Social Presence 0\/10 \(3\): Org B, Org C, Org D/.test(exec), /AEO score 0\/100 \(3\): Org B, Org C, Org D/.test(exec)], [true, true, true]);
  eq("a failed Instagram and an unreadable LinkedIn page are marked on the organisation's line", [/Org B:.*\[Instagram collection failed — counted as 0/.test(exec), /Org C:.*\[no LinkedIn page the data source can read — counted as 0/.test(exec), /Org A:.*\[/.test(exec.split("\n").find((l) => l.startsWith("Org A:")) || "")], [true, true, false]);
  eq("the prompt tells the model to use the lists and not to present failed cells as measured zeros", /use the FACTS lines/.test(exec) && /do not present it as a measured zero/.test(exec), true);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
