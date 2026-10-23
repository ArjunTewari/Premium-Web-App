// Run: node tests/resume.test.cjs  (needs the app's node_modules). No network.
// A run given saved data must skip steps 1–4b (no collector is touched), carry on from the
// saved data, pass the audit and write the report; a checkpoint for a different run is refused.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));

// Claude CLI stub: the audit reviewer gets a pass; everything else fails (those steps degrade gracefully).
let askCalls = [];
const claudeStub = {
  askClaude: async (prompt) => { askCalls.push(prompt.slice(0, 60)); if (/independent auditor/.test(prompt)) return '{"verdict":"pass","findings":[]}'; throw new Error("stubbed: no Claude in this test"); },
  usage: { calls: 0, failures: 0 }, ClaudeCliError: Error, resolveCli: () => ({}), childEnv: () => ({}),
};
// Any collector module being used would be a failure of "nothing is fetched".
const touched = [];
const origLoad = Module._load;
Module._load = function (req, parent, ...a) {
  if (/(^|\/)claude-cli(\.js)?$/.test(req)) return claudeStub;
  const r = origLoad.call(this, req, parent, ...a);
  return r;
};
const P = require(path.join(__dirname, "..", "src", "pipeline", "pipeline.js"));
const Checkpoint = require(path.join(__dirname, "..", "src", "pipeline", "checkpoint.js"));
for (const mod of ["exa-collector", "apidirect-collector", "youtube-er", "social-intelligence"]) {
  const m = require(path.join(__dirname, "..", "src", "pipeline", mod + ".js"));
  for (const k of Object.keys(m)) if (typeof m[k] === "function" && ["fetchCorpus", "run", "runAEO", "fetchTwitter", "fetchLinkedIn", "fetchInstagram"].includes(k)) {
    const f = m[k]; m[k] = (...args) => { touched.push(`${mod}.${k}`); return f(...args); };
  }
}

let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const ORGS = ["Org A", "Org B"];
const post = (i, t, k) => ({ url: `https://twitter.com/a/status/${i}`, snippet: t, keywords_found: k, likes: 7, replies: 1, retweets: 2, date: "2026-10-14" });
const social = [
  { org: "Org A", presenceScore: 6, scoreBreakdown: { volume: { pts: 3, max: 4, detail: "" }, breadth: { pts: 2, max: 3, detail: "" }, relevance: { pts: 1, max: 3, detail: "" } },
    twData: { postCount: 2, totalLikes: 14, totalReplies: 2, totalRetweets: 4, totalViews: 100, followers: 5000, er: 0.2, topPosts: [post(1, "PM2.5 in Delhi", ["pm2.5"]), post(2, "NCAP funding", ["ncap"])] },
    liData: { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, followers: 900, er: 0, topPosts: [] }, igData: { postCount: 0, followers: 0, er: 0, topPosts: [] }, ytChData: { subscribers: 0 } },
  { org: "Org B", presenceScore: 4, twData: { postCount: 1, totalLikes: 7, totalReplies: 1, totalRetweets: 2, totalViews: 50, followers: 3000, er: 0.3, topPosts: [post(11, "Smog in Delhi", ["smog"])] },
    liData: { postCount: 0, followers: 0, er: 0, topPosts: [] }, igData: { postCount: 0, followers: 0, er: 0, topPosts: [] }, ytChData: { subscribers: 0 } },
];
const baseCfg = () => ({ ORGS, DATE_FROM: "2026-10-12", DATE_TO: "2026-10-18", CLIENT_NAME: "Test", SCOPE_KEYWORDS: [], AEO_QUERIES: [], FRAMEWORK: "air-quality", CLAUDE_KEY: "claude-cli", outDir });
const state = () => ({ arts: { "Org A": [], "Org B": [] }, cls: { "Org A": [], "Org B": [] }, exaWhiteSpace: [], aeoResults: { "Org A": { mentions: 1, score: 3, llmBreakdown: {}, topResponse: "", questionResults: {} }, "Org B": { mentions: 0, score: 0, llmBreakdown: {}, topResponse: "", questionResults: {} } }, aeoQueriesUsed: ["Which organisations lead research on air quality in India?"], socialERResults: social, youtubeERResults: [] });

(async () => {
  const fp = Checkpoint.fingerprint(baseCfg(), "air-quality");
  const buf = Checkpoint.pack(fp, state(), { apidirectCalls: 120, openaiCalls: 15 });
  const chk = Checkpoint.unpack(buf);
  eq("a checkpoint survives pack/unpack", [chk.fingerprint.orgs, chk.state.socialERResults[0].twData.postCount, chk.cost.apidirectCalls], [ORGS, 2, 120]);
  eq("file name carries framework, window and org count", Checkpoint.parseName(Checkpoint.name(fp)), { framework: "air-quality", dateFrom: "2026-10-12", dateTo: "2026-10-18", orgCount: 2, hash: Checkpoint.name(fp).match(/-([0-9a-f]{8})\.json\.gz$/)[1] });
  eq("same run -> usable", Checkpoint.mismatch(chk, fp), []);
  eq("different dates / orgs / keywords are each refused", [
    Checkpoint.mismatch(chk, { ...fp, dateFrom: "2026-10-05" }).length > 0,
    Checkpoint.mismatch(chk, { ...fp, orgs: ["Org A", "Org C"] }).length > 0,
    Checkpoint.mismatch(chk, { ...fp, scopeKeywords: ["x"] }).length > 0,
    Checkpoint.mismatch(chk, { ...fp, framework: "climate" }).length > 0], [true, true, true, true]);
  let bad = ""; try { Checkpoint.unpack(Buffer.from("not gzip")); } catch (e) { bad = e.message; }
  eq("a damaged file is rejected", /damaged/.test(bad), true);

  // a resumed run
  const msgs = [];
  const r = await P.run({ ...baseCfg(), resumeCheckpoint: chk }, (m, l) => msgs.push(m));
  eq("resumed run writes the report", [!!r.htmlName, fs.existsSync(path.join(outDir, r.htmlName))], [true, true]);
  eq("steps 1 to 4b are skipped: no collector was called", touched, []);
  eq("log says it resumed and the audit passed", [msgs.some((m) => /RESUMED from saved data/.test(m)), msgs.some((m) => /AUDIT · passed/.test(m))], [true, true]);
  const html = fs.readFileSync(path.join(outDir, r.htmlName), "utf8");
  eq("the saved social figures are in the report", [/X\/Twitter\s*—\s*<span[^>]*>2 tweets/.test(html), /emerald-audit/.test(html)], [true, true]);
  eq("the saved fetching cost is carried into the report's cost", r.cost.counts.apidirectCalls >= 120 && r.cost.counts.openaiCalls >= 15, true);

  // a first (non-resumed) run's checkpoint writer is exercised by run() only after step 4b, which needs the network;
  // here we check the refusal path of a mismatched resume
  let refused = ""; try { await P.run({ ...baseCfg(), DATE_FROM: "2026-10-05", resumeCheckpoint: chk }, () => {}); } catch (e) { refused = e.message; }
  eq("saved data for a different window is refused before anything runs", /does not match this run/.test(refused) && touched.length === 0, true);

  // ── a normal run saves its checkpoint right after step 4b, and that checkpoint resumes ──
  const dir = path.join(__dirname, "..", "src", "pipeline");
  require(path.join(dir, "exa-collector.js")).fetchCorpus = async () => [];
  require(path.join(dir, "social-intelligence.js")).runAEO = async () => ({ ...state().aeoResults, _queriesUsed: ["q1"] });
  require(path.join(dir, "social-er.js")).run = async () => JSON.parse(JSON.stringify(social));
  require(path.join(dir, "youtube-er.js")).run = async () => [];
  const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test2-"));
  let sunk = null;
  const msgs2 = [];
  const r2 = await P.run({ ...baseCfg(), outDir: outDir2, onCheckpoint: async (name, data) => { sunk = { name, size: data.length }; } }, (m) => msgs2.push(m));
  const cpName = Checkpoint.name(fp);
  eq("a normal run writes its checkpoint to disk and hands it to the store", [fs.existsSync(path.join(outDir2, cpName)), sunk && sunk.name], [true, cpName]);
  eq("the run log says where the data went", msgs2.some((m) => /CHECKPOINT · collected data saved/.test(m)), true);
  const saved = Checkpoint.unpack(fs.readFileSync(path.join(outDir2, cpName)));
  eq("the saved data holds what step 4 produced", [saved.state.socialERResults.length, saved.state.aeoQueriesUsed], [2, ["q1"]]);
  const r3 = await P.run({ ...baseCfg(), outDir: outDir2, resumeCheckpoint: saved }, () => {});
  const h2 = fs.readFileSync(path.join(outDir2, r2.htmlName), "utf8"), h3 = fs.readFileSync(path.join(outDir2, r3.htmlName), "utf8");
  const nums = (h) => (h.match(/X\/Twitter\s*—\s*<span[^>]*>\d+ tweets?/g) || []).join("|");
  eq("a report built from the checkpoint shows the same figures as the original run", nums(h2) === nums(h3) && nums(h2).length > 0, true);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
