// Run: node tests/exclusion.test.cjs  (needs the app's node_modules). No network, no Claude.
// 1. a keyword that appears only inside a list of names ("... WRI India WRI Air Quality Ola Electric ...") does not make a post
//    about the subject (the 26 Oct RaahGiri posts); 2. when the reviewer names counted posts that are not about the subject,
//    they are left out and steps 5-6 run again on the same saved data; 3. that is bounded and disclosed.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
const dir = path.join(__dirname, "..", "src", "pipeline");
const claudeStub = { askClaude: async (p) => {
  if (/Write 3 comparative findings/.test(p)) return JSON.stringify([{ headline: "CREA recorded 2 articles", detail: "CREA recorded 2 articles.", section_ref: "§03 AQ Press Analytics" }, { headline: "TERI recorded 1 article", detail: "TERI recorded 1 article.", section_ref: "§03 AQ Press Analytics" }, { headline: "Social presence", detail: "CREA recorded 6/10 social presence.", section_ref: "§Social Media" }]);
  const m = /Generate exactly 4 strategic actions for "([^"]+)"/.exec(p);
  if (m) return JSON.stringify([1, 2, 3, 4].map((i) => ({ org: m[1], priority: "Optimise", area: "Social", action: `a${i}`, rationale: "r" })));
  throw new Error("stub"); }, usage: {}, ClaudeCliError: Error, resolveCli: () => ({}), childEnv: () => ({}) };
const orig = Module._load; Module._load = function (r, ...a) { return /(^|\/)claude-cli(\.js)?$/.test(r) ? claudeStub : orig.call(this, r, ...a); };
const A = require(path.join(dir, "audit.js")), CP = require(path.join(dir, "checkpoint.js")), P = require(path.join(dir, "pipeline.js")), Reviewer = require(path.join(dir, "claude-review.js")), C = require(path.join(dir, "apidirect-collector.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

// ── 1. keywords inside a list of names ──
require(path.join(dir, "frameworks")).setActiveFramework("air-quality");
const kw = C.buildAqKeywords([]);
const list = "We are delighted to welcome our panelist to #BangaloreClimateDataWeek. Partners at the event: MoveInSync QuickRide CSTEP Rainmatter by Zerodha Rainmatter Foundation WRI India WRI Air Quality Ola Electric Ather Energy TERI - The Energy and Resources Institute OMI Foundation Asar";
const sentence = "We are delighted to welcome our panelist to discuss how better air quality monitoring can guide city policy this winter.";
const term = (t) => C.buildAqKeywords([]).includes(t) ? t : "air quality";
const li = (url, text) => ({ url, text, date: "2026-10-14T09:00:00Z", likes: 5, comments: 1, shares: 0 });
const resLi = (posts) => C.reprocessLinkedIn("Org", { rawPosts: posts, rawMeta: { followers: 1000, source: "timeline", timelinePages: 1 } }, kw, () => {});
eq("'WRI Air Quality' inside a list of partner names does not make the post about air quality", resLi([li("u1", list)]).postCount, 0);
eq("the same words in an ordinary sentence do", resLi([li("u2", sentence)]).postCount, 1);
eq("a hashtag list is not a list of names", resLi([li("u3", "Today #AirQuality #CleanAir #Delhi #Smog #AQI #Pollution #Health #India #Policy #Data #Research air quality")]).postCount, 1);

// ── 2./3. the plan ──
const mkRes = (org, urls) => ({ org, twData: { topPosts: urls.map((u) => ({ url: u })) }, liData: { topPosts: [] }, igData: { topPosts: [] } });
const err = (org, urls, where = `${org} · X posts`) => ({ source: "review", severity: "error", org, where, issue: "not about the subject", postUrls: urls });
let plan = A.exclusionPlan([err("CREA", ["u1"])], [mkRes("CREA", ["u1", "u2"])]);
eq("a data error that names a counted post is planned for exclusion", plan.urls, ["u1"]);
eq("every data error must name posts", A.exclusionPlan([err("CREA", ["u1"]), err("TERI", [])], [mkRes("CREA", ["u1"]), mkRes("TERI", ["x"])]).urls, []);
eq("a named post that is not a counted post is refused", A.exclusionPlan([err("CREA", ["nope"])], [mkRes("CREA", ["u1"])]).urls, []);
eq("more than 3 posts for one organisation is refused", A.exclusionPlan([err("CREA", ["a", "b", "c", "d"])], [mkRes("CREA", ["a", "b", "c", "d"])]).urls, []);
eq("summary errors do not count as data errors", A.exclusionPlan([err("CREA", ["u1"]), { source: "review", severity: "error", org: "CREA", where: "CREA · executive summary ('x')", issue: "y" }], [mkRes("CREA", ["u1"])]).urls, ["u1"]);

// ── the exclusion is applied by a re-count ──
const tw = (id, text) => ({ id: String(id), url: `https://twitter.com/a/status/${id}`, text, date: "2026-10-14", likes: 7, replies: 1, retweets: 2, views: 0, author: "", is_retweet: false });
const rawTweets = [tw(1, "PM2.5 in Delhi today"), tw(2, "NCAP funding for clean air")];
const twSaved = C.reprocessTwitter("CREA", { rawTweets, rawMeta: { handle: "x", followers: 5000, duplicatesRemoved: 0, pagesFetched: 1, searchFailed: false, searchCapHit: false, timelineRan: false, timelineFailed: false, timelinePages: 0, timelineCapHit: false, timelineIds: [] } }, kw, { from: new Date("2026-10-12"), to: new Date("2026-10-18T23:59:59Z") }, () => {});
eq("two on-topic tweets counted", twSaved.postCount, 2);
C.setExcludedPosts(["https://twitter.com/a/status/1"]);
const twEx = C.reprocessTwitter("CREA", twSaved, kw, { from: new Date("2026-10-12"), to: new Date("2026-10-18T23:59:59Z") }, () => {});
C.setExcludedPosts([]);
eq("an excluded post is left out of the count", [twEx.postCount, twEx.topPosts.map((t) => t.url)], [1, ["https://twitter.com/a/status/2"]]);

// ── end to end: reviewer names a post → left out → report built again → passes; disclosed; kept with the saved data ──
const ORGS = ["CREA", "TERI"];
const empty = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, followers: 0, er: 0, topPosts: [] };
const social = [
  { org: "CREA", presenceScore: 4, liData: { ...empty }, twData: { ...twSaved }, igData: { ...empty }, ytChData: { subscribers: 0 } },
  { org: "TERI", presenceScore: 0, liData: { ...empty }, twData: { ...empty, totalReplies: 0, totalRetweets: 0, totalViews: 0 }, igData: { ...empty }, ytChData: { subscribers: 0 } },
];
const art = (t) => ({ title: t, url: "https://x/" + t, outlet: "The Hindu", date: "2026-10-14", snippet: "air quality " + t, fullText: "air quality " + t, citation_quality: "Data Cited", aq_relevant: true, aq_subtopic: "General AQ" });
const aeo = (o) => ({ mentions: 0, score: 0, llmBreakdown: {}, topResponse: "", questionResults: {} });
const fp = { framework: "air-quality", orgs: ORGS, dateFrom: "2026-10-12", dateTo: "2026-10-18", scopeKeywords: [], aeoQueries: [] };
const state = { arts: { CREA: [art("a1"), art("a2")], TERI: [art("t1")] }, cls: { CREA: [], TERI: [] }, exaWhiteSpace: [], aeoResults: { CREA: aeo(), TERI: aeo() }, aeoQueriesUsed: ["q?"], socialERResults: social, youtubeERResults: [] };
const cfgFor = (out, chk, extra = {}) => ({ ORGS, DATE_FROM: fp.dateFrom, DATE_TO: fp.dateTo, CLIENT_NAME: "t", SCOPE_KEYWORDS: [], AEO_QUERIES: [], FRAMEWORK: "air-quality", CLAUDE_KEY: "claude-cli", outDir: out, resumeCheckpoint: chk, ...extra });

(async () => {
  const chk = CP.unpack(CP.pack(fp, state, {}));
  let reviews = 0, sawCount = [];
  Reviewer.review = async (pack) => {
    reviews++;
    const x = pack.organisations[0].social.x;
    sawCount.push(x.posts);
    return reviews === 1
      ? { verdict: "fail", findings: [{ severity: "error", org: "CREA", where: "CREA · X posts", issue: "this post is not about the subject", evidence: "x", postUrls: ["https://twitter.com/a/status/1"] }], model: "stub" }
      : { verdict: "pass", findings: [], model: "stub" };
  };
  let out = fs.mkdtempSync(path.join(os.tmpdir(), "excl-")); const msgs = []; let sunk = null;
  let r; try { r = await P.run(cfgFor(out, chk, { onCheckpoint: async (n, b) => { sunk = CP.unpack(b); } }), (m) => msgs.push(m)); } catch (e) { msgs.push("ERR " + e.message.slice(0, 300)); }
  const html = r ? fs.readFileSync(path.join(out, r.htmlName), "utf8") : "";
  eq("the named post is left out, the report is built again from the same data and passes", [!!r, reviews, sawCount], [true, 2, [2, 1]]);
  eq("the log says what was left out; nothing was fetched", [msgs.some((m) => /counted post\(s\) were named as not being about the subject/.test(m)), msgs.some((m) => /excluded: https:\/\/twitter.com\/a\/status\/1/.test(m))], [true, true]);
  eq("the report states how many posts were left out", /1 post\(s\) left out after the independent review/.test(html), true);
  eq("the exclusion is kept with the saved data", sunk && sunk.state.excludePosts, ["https://twitter.com/a/status/1"]);

  // a data error that does not name posts is not repaired this way
  reviews = 0;
  Reviewer.review = async () => ({ verdict: "fail", findings: [{ severity: "error", org: "CREA", where: "CREA · X posts", issue: "counts look wrong", evidence: "x" }], model: "stub" });
  out = fs.mkdtempSync(path.join(os.tmpdir(), "excl2-")); let e2 = "";
  try { await P.run(cfgFor(out, chk), () => {}); } catch (e) { e2 = e.message; }
  eq("an error that names no posts still stops the report", /AUDIT FAILED/.test(e2), true);

  // a saved exclusion is applied on a later resume
  reviews = 0; let seen2 = null;
  Reviewer.review = async (pack) => { seen2 = pack.organisations[0].social.x.posts; return { verdict: "pass", findings: [], model: "stub" }; };
  out = fs.mkdtempSync(path.join(os.tmpdir(), "excl3-"));
  const chk2 = CP.unpack(CP.pack(fp, { ...state, excludePosts: ["https://twitter.com/a/status/1"] }, {}));
  r = null; try { r = await P.run(cfgFor(out, chk2), () => {}); } catch (e) { /* ignore */ }
  eq("exclusions saved with the data are applied when it is resumed later", [!!r, seen2], [true, 1]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
