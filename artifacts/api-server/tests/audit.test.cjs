// Run: node tests/audit.test.cjs  (needs the app's node_modules). No network, no Claude.
// The rule layer of the audit must stop the 18 Oct 2026 fault and pass a consistent report.
const path = require("path");
const A = require(path.join(__dirname, "..", "src", "pipeline", "audit.js"));
const Reviewer = require(path.join(__dirname, "..", "src", "pipeline", "claude-review.js"));
let fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got  ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const post = (i, text, kw) => ({ url: `https://twitter.com/x/status/${i}`, snippet: text, keywords_found: kw, likes: 7, replies: 1, retweets: 2 });
const offTopic = post(2109524554850705722, "India Quarterly Energy Snapshot: electricity generation up 11%", []);
const ORGS = ["CREA", "TERI"];
const data = (bad) => bad
  ? { CREA: { sov: 40, aeo: 12, social: 10, pressShare: 30, llmShare: 40, socialShare: 68.7, score: 46.2 }, TERI: { sov: 60, aeo: 18, social: 4, pressShare: 70, llmShare: 60, socialShare: 31.3, score: 53.8 } }
  : { CREA: { sov: 40, aeo: 12, social: 6, pressShare: 40, llmShare: 40, socialShare: 60, score: 46.7 }, TERI: { sov: 60, aeo: 18, social: 4, pressShare: 60, llmShare: 60, socialShare: 40, score: 53.3 } };
const social = (bad) => [
  { org: "CREA", twData: bad
      ? { postCount: 100, totalLikes: 95, totalReplies: 90, totalRetweets: 15, topPosts: [offTopic, offTopic, offTopic, offTopic, offTopic] }
      : { postCount: 2, totalLikes: 14, totalReplies: 2, totalRetweets: 4, topPosts: [post(1, "PM2.5 in Delhi", ["pm2.5"]), post(2, "NCAP funding", ["ncap"])] }, liData: { postCount: 0 }, igData: { postCount: 0 } },
  { org: "TERI", twData: { postCount: 1, totalLikes: 7, totalReplies: 1, totalRetweets: 2, topPosts: [post(11, "Smog in Delhi", ["smog"])] }, liData: { postCount: 0 }, igData: { postCount: 0 } },
];
const page = (n) => `<div>X/Twitter — <span style="c">${n} tweets</span></div><div>X/Twitter — <span>1 tweet</span></div>`;

const bad = A.checkDeterministic({ ORGS, data: data(true), socialERResults: social(true), execF: [], html: page(100) });
eq("fault: a repeated post is an error", bad.errors.some((e) => /listed more than once/.test(e.issue)), true);
eq("fault: an off-topic counted post is an error", bad.errors.some((e) => /none of the subject keywords/.test(e.issue)), true);
eq("fault: the multiples-of-5 pattern is flagged", bad.warnings.some((w) => /multiples of 5/.test(w.issue)), true);

const good = A.checkDeterministic({ ORGS, data: data(false), socialERResults: social(false), execF: [], html: page(2) });
eq("consistent report: no errors", good.errors, []);

const mism = A.checkDeterministic({ ORGS, data: data(false), socialERResults: social(false), execF: [], html: page(99) });
eq("page showing a different count than the data is an error", mism.errors.some((e) => /report page shows/.test(e.issue)), true);

const shares = data(false); shares.CREA.socialShare = 90;
eq("shares that do not add to 100 are an error", A.checkDeterministic({ ORGS, data: shares, socialERResults: social(false), execF: [], html: "" }).errors.some((e) => /add up to/.test(e.issue)), true);

const trunc = social(false); trunc[0].twData.capHit = true; trunc[0].twData.duplicatesRemoved = 3;
const w = A.checkDeterministic({ ORGS, data: data(false), socialERResults: trunc, execF: [], html: "" });
eq("page-limit hit and removed repeats are warnings, not errors", [w.errors.length, w.warnings.length], [0, 2]);

const tl = social(false); tl[0].twData.timelineAdded = 2; tl[0].twData.timelineRan = true; tl[1].twData.timelineFailed = true;
const wt = A.checkDeterministic({ ORGS, data: data(false), socialERResults: tl, execF: [], html: "" });
eq("posts found only by the timeline, and a failed cross-check, are warnings", [wt.errors.length, wt.warnings.filter((x) => /timeline/.test(x.issue)).length], [0, 2]);
const z = social(false); z[1].twData = { postCount: 0, followers: 4500, topPosts: [] };
eq("a zero that was not cross-checked is flagged", A.checkDeterministic({ ORGS, data: data(false), socialERResults: z, execF: [], html: "" }).warnings.some((x) => /not cross-checked/.test(x.issue)), true);
z[1].twData.timelineRan = true;
eq("a zero that was cross-checked is not flagged", A.checkDeterministic({ ORGS, data: data(false), socialERResults: z, execF: [], html: "" }).warnings.some((x) => /not cross-checked/.test(x.issue)), false);
eq("reviewer reply is parsed", Reviewer.parseReview('{"verdict":"fail","findings":[{"severity":"error","org":"CREA","where":"X posts","issue":"repeat","evidence":"same id"}]}').findings[0].org, "CREA");
let threw = false; try { Reviewer.parseReview("not json"); } catch { threw = true; }
eq("an unreadable reviewer reply is rejected, never treated as a pass", threw, true);
eq("a reply wrapped in a sentence and a code fence is still read", Reviewer.parseReview('Here you go:\n```json\n{"verdict":"pass","findings":[]}\n```').verdict, "pass");
let bad2 = false; try { Reviewer.parseReview('{"verdict":"maybe","findings":[]}'); } catch { bad2 = true; }
eq("an unknown verdict is rejected", bad2, true);

// ── runAudit end to end with the Claude CLI stubbed ──
const Module = require("module"); const origLoad = Module._load;
let reply; const claudeStub = { askClaude: async () => { const r = reply(); if (r instanceof Error) throw r; return r; }, usage: {}, ClaudeCliError: Error };
Module._load = function (req, ...a) { return /claude-cli(\.js)?$/.test(req) ? claudeStub : origLoad.call(this, req, ...a); };
delete require.cache[require.resolve(path.join(__dirname, "..", "src", "pipeline", "claude-review.js"))];
delete require.cache[require.resolve(path.join(__dirname, "..", "src", "pipeline", "audit.js"))];
const A2 = require(path.join(__dirname, "..", "src", "pipeline", "audit.js"));
const ctxOk = { ORGS, data: data(false), socialERResults: social(false), execF: [], actions: [], html: page(2), dateFrom: "2026-10-12", dateTo: "2026-10-18", subject: "air quality" };
(async () => {
  reply = () => '{"verdict":"pass","findings":[]}';
  let r = await A2.runAudit(ctxOk);
  eq("consistent report + reviewer pass -> passed", [r.passed, r.review.ran], [true, true]);
  reply = () => '{"verdict":"fail","findings":[{"severity":"error","org":"CREA","where":"X posts","issue":"repeat","evidence":"same id"}]}';
  r = await A2.runAudit(ctxOk);
  eq("reviewer error finding -> blocked", [r.passed, r.errors.some((e) => e.source === "review")], [false, true]);
  reply = () => '{"verdict":"fail","findings":[]}';
  eq("fail verdict without a finding -> still blocked", (await A2.runAudit(ctxOk)).passed, false);
  reply = () => '{"verdict":"pass","findings":[{"severity":"warning","org":"TERI","where":"X","issue":"odd","evidence":"x"}]}';
  r = await A2.runAudit(ctxOk);
  eq("reviewer warning -> passes, recorded", [r.passed, r.warnings.some((w) => w.source === "review")], [true, true]);
  reply = () => new Error("Claude CLI is not authenticated");
  r = await A2.runAudit(ctxOk);
  eq("reviewer unavailable -> blocked, never a silent pass", [r.passed, r.errors[0].where], [false, "Claude CLI review"]);
  reply = () => "I could not parse this";
  eq("garbage reply -> blocked", (await A2.runAudit(ctxOk)).passed, false);
  reply = () => { throw new Error("must not be called"); };
  r = await A2.runAudit({ ...ctxOk, data: data(true), socialERResults: social(true), html: page(100) });
  eq("rule errors block before the reviewer is even asked", [r.passed, r.review.ran], [false, false]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})();
