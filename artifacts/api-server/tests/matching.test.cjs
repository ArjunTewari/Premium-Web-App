// Run: node tests/matching.test.cjs  (needs the app's node_modules). Scripted fake API; no network.
// The 23 Oct review found counted posts that were not about air quality: "grap" inside "photography" /
// "graphite", "clean air" inside a link (energyandcleanair.org) or an account name, a retweet of another
// account. Those are fixed in the matching rule; and saved posts can be counted again under the current rule.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
process.env.LINKEDIN_CACHE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "match-cache-")), "cache.json");
let script = null; const calls = [];
const fakeAxios = { get: async (url, { params }) => { calls.push(url); return { data: script(url.replace("https://apidirect.io/v1/", ""), params) }; } };
const orig = Module._load;
Module._load = function (req, ...a) { if (req === "axios") return fakeAxios; return orig.call(this, req, ...a); };
const dir = path.join(__dirname, "..", "src", "pipeline");
const FW = require(path.join(dir, "frameworks"));
const C = require(path.join(dir, "apidirect-collector.js"));
const SocialER = require(path.join(dir, "social-er.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

FW.setActiveFramework("air-quality");
const m = (text, term) => FW.termMatches(text, term);

// ── short acronyms stand alone; everything else still matches anywhere ──
eq("'grap' is not 'photography', 'graphite' or 'biography'", [m("campus photography and painting", "grap"), m("lithium, cobalt, nickel, graphite", "grap"), m("a new biography", "grap")], [false, false, false]);
eq("GRAP stands alone: 'GRAP', 'GRAP-IV', '#GRAP', 'GRAPs'", [m("GRAP restrictions", "grap"), m("Stage GRAP-IV is on", "grap"), m("#GRAP update", "grap"), m("GRAPs in force", "grap")], [true, true, true, true]);
eq("'ncap' / 'aqi' / 'smog' stand alone", [m("NCAP funds released", "ncap"), m("Delhi AQI today", "aqi"), m("Heat-AQI link", "aqi"), m("thick smog", "smog"), m("ncapital", "ncap"), m("taqiyya", "aqi"), m("smoggy", "smog")], [true, true, true, true, false, false, false]);
eq("longer terms still match anywhere (behaviour kept)", [m("PM2.5 levels", "pm2.5"), m("Stubble burning season", "stubble burn"), m("ambient air quality", "air quality"), m("emissions", "emission")], [true, true, true, true]);

const day = (d) => `2026-10-${String(d).padStart(2, "0")}T10:00:00Z`;
const range = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-18T23:59:59Z") };
const kw = C.buildAqKeywords([]);
const tw = (id, text, extra = {}) => ({ id: String(id), text, date: day(14), likes: 4, replies: 1, retweets: 1, views: 10, url: `https://twitter.com/a/status/${id}`, ...extra });

// ── X ──
const route = (o) => (ep, p) => ep === "twitter/user" ? { user: { followers_count: 8100 } } : ep === "twitter/posts" ? (o.search ? o.search(p.page) : { tweets: [] }) : ep === "twitter/user/tweets" ? (o.timeline ? o.timeline(p.page) : { tweets: [] }) : {};
const runX = async (o) => { script = route(o); calls.length = 0; return C.fetchTwitter("CREA", "CREACleanAir", "k", range, kw, () => {}); };
(async () => {
  process.env.X_TIMELINE_MODE = "off";
  let r = await runX({ search: (pg) => pg === 1 ? { tweets: [
    tw(1, "Monthly analysis of Russian fossil fuel exports & sanctions. Read more: https://energyandcleanair.org/publication/russian-exports"),
    tw(2, "Air quality in Delhi: PM2.5 over 300 today #CleanAir"),
    tw(3, "RT @CAQM_Official: Operation Clean Air - inspection drive in Gurugram"),
    tw(4, "A new report out now", { title: "Centre for Research on Energy and Clean Air on X: A new report out now" }),
  ] } : { tweets: [] } });
  eq("X: a link containing 'cleanair', an account-name title and a retweet are not air quality posts", [r.postCount, r.topPosts.map((t) => t.url)], [1, ["https://twitter.com/a/status/2"]]);
  eq("X: counted by the real hashtag/phrase, and the drops are reported", [r.topPosts[0].keywords_found.includes("air quality"), r.droppedNoKeyword, r.droppedRetweets], [true, 2, 1]);
  r = await runX({ search: (pg) => pg === 1 ? { tweets: [tw(5, "Breathe easy #CleanAir"), tw(6, "no hashtag: cleanair")] } : { tweets: [] } });
  eq("X: '#CleanAir' counts, a bare 'cleanair' word does not", r.topPosts.map((t) => t.url), ["https://twitter.com/a/status/5"]);

  // ── LinkedIn ──
  const li = (id, text, extra = {}) => ({ url: `https://www.linkedin.com/posts/o_activity-${id}`, text, date: day(14), likes: 5, comments: 1, shares: 0, ...extra });
  const liRoute = (posts) => (ep, p) => ep === "linkedin/company" ? { company_id: 5, name: "Org", followers: 1000 } : ep === "linkedin/company/posts" ? { posts: p.page === 1 ? posts : [] } : { posts: [] };
  const runLi = async (posts) => { script = liRoute(posts); calls.length = 0; return C.fetchLinkedIn("Org", "org-x", "k", range, kw, () => {}); };
  let l = await runLi([
    li(1, "Bridges 18th Anniversary Competition: campus photography, painting and poetry"),
    li(2, "Critical minerals: lithium, cobalt, nickel, graphite and rare earths"),
    li(3, "Our brief on air quality and GRAP-IV measures in Delhi"),
    li(4, "Join us for the launch", { title: "Centre for Research on Energy and Clean Air on LinkedIn: Join us for the launch" }),
  ]);
  eq("LinkedIn: photography/graphite/company-name-in-title posts are not counted", [l.postCount, l.topPosts[0].url], [1, "https://www.linkedin.com/posts/o_activity-3"]);

  // ── counting the saved posts again ──
  process.env.X_TIMELINE_MODE = "off";
  const X = await runX({ search: (pg) => pg === 1 ? { tweets: [tw(10, "NCAP funding and PM2.5 data"), tw(11, "Air quality alert for Delhi"), tw(12, "An unrelated announcement")] } : { tweets: [] } });
  eq("a fetched X result carries the saved tweets (in-window only) and what is needed to re-count", [X.rawTweets.length, X.rawMeta.handle, typeof X.rawMeta.followers], [3, "CREACleanAir", "number"]);
  const callsBefore = calls.length;
  const same = C.reprocessTwitter("CREA", JSON.parse(JSON.stringify(X)), kw, range, () => {});
  eq("re-counting with the same rules gives the same figures (through a JSON round trip)", [same.postCount, same.totalLikes, same.droppedNoKeyword, same.topPosts.map((t) => t.url)], [X.postCount, X.totalLikes, X.droppedNoKeyword, X.topPosts.map((t) => t.url)]);
  const stricter = C.reprocessTwitter("CREA", X, kw.filter((k) => k !== "ncap" && k !== "pm2.5"), range, () => {});
  eq("re-counting under a different rule changes the count, with no API call", [stricter.postCount, calls.length === callsBefore], [1, true]);

  const L = await runLi([li(20, "air quality note", { likes: 9 }), li(21, "annual report"), li(22, "GRAP update", { likes: 3 })]);
  const L2 = C.reprocessLinkedIn("Org", JSON.parse(JSON.stringify(L)), kw, () => {});
  eq("LinkedIn re-count with the same rules gives the same figures", [L2.postCount, L2.totalLikes, L2.droppedNoKeyword], [L.postCount, L.totalLikes, L.droppedNoKeyword]);
  eq("LinkedIn saved posts: all window posts, before the keyword rule", [L.rawPosts.length, L.postCount], [3, 2]);

  // ── social-er: a whole saved result set, polluted by the old rule, is corrected on resume ──
  const empty = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, followers: 0, er: 0, topPosts: [] };
  const polluted = { org: "Org A", presenceScore: 9, liData: empty, igData: empty, ytChData: { subscribers: 0 },
    // what the old rule had counted: 13 tweets, none about air quality (as saved raw posts)
    twData: { postCount: 13, totalLikes: 50, totalReplies: 5, totalRetweets: 5, totalViews: 0, followers: 8100, er: 0.02, topPosts: [{ url: "u", snippet: "Russian exports", keywords_found: ["clean air"] }],
      rawTweets: Array.from({ length: 13 }, (_, i) => ({ id: String(i), url: `u${i}`, text: `Russian fossil fuel exports analysis ${i} https://energyandcleanair.org/x`, date: day(14), likes: 4, replies: 0, retweets: 0, views: 0, author: "", is_retweet: false })),
      rawMeta: { handle: "CREACleanAir", followers: 8100, duplicatesRemoved: 0, pagesFetched: 1, searchFailed: false, searchCapHit: false, timelineRan: false, timelineFailed: false, timelinePages: 0, timelineCapHit: false, timelineIds: [] } } };
  const noRaw = { org: "Org B", presenceScore: 5, liData: empty, igData: empty, ytChData: { subscribers: 0 }, twData: { ...empty, postCount: 2, totalReplies: 0, totalRetweets: 0, totalViews: 0, topPosts: [] } };
  const saved = JSON.parse(JSON.stringify([polluted, noRaw]));
  const rg = SocialER.regate(saved, { DATE_FROM: "2026-10-12", DATE_TO: "2026-10-18", SCOPE_KEYWORDS: [] }, () => {});
  const a = rg.results.find((x) => x.org === "Org A"), b = rg.results.find((x) => x.org === "Org B");
  eq("polluted saved posts are re-counted: 13 off-topic tweets -> 0, score follows", [a.twData.postCount, a.twitterPosts, a.presenceScore < 9], [0, 0, true]);
  eq("a result saved without posts is kept exactly as saved", [b.twData.postCount, rg.asSaved > 0], [2, true]);
  eq("results are re-ranked", rg.results.map((x) => x.rank).every((n) => Number.isInteger(n)), true);

  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
