// Run: node tests/audit.test.cjs  (needs the app's node_modules). No network, no Codex.
// The rule layer of the audit must stop the 18 Oct 2026 fault and pass a consistent report.
const path = require("path");
const A = require(path.join(__dirname, "..", "src", "pipeline", "audit.js"));
const Codex = require(path.join(__dirname, "..", "src", "pipeline", "codex-review.js"));
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

eq("codex reply is parsed", Codex.parseReview('{"verdict":"fail","findings":[{"severity":"error","org":"CREA","where":"X posts","issue":"repeat","evidence":"same id"}]}').findings[0].org, "CREA");
let threw = false; try { Codex.parseReview("not json"); } catch { threw = true; }
eq("an unreadable Codex reply is rejected, never treated as a pass", threw, true);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
