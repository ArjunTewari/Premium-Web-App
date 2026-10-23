// Run: node tests/linkedin.test.cjs  (needs the app's node_modules). Scripted fake API; no network.
const Module = require("module"); const path = require("path"); const os = require("os"); const fs = require("fs");
process.env.LINKEDIN_CACHE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "li-cache-")), "cache.json");
let script = null; const calls = [];
const fakeAxios = { get: async (url, { params }) => { calls.push({ url, params }); return { data: script(url.replace("https://apidirect.io/v1/", ""), params) }; } };
const orig = Module._load;
Module._load = function (req, ...a) { if (req === "axios") return fakeAxios; return orig.call(this, req, ...a); };
const C = require(path.join(__dirname, "..", "src", "pipeline", "apidirect-collector.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const post = (id, text, day, extra = {}) => ({ url: `https://www.linkedin.com/posts/org_activity-${id}`, snippet: text, date: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`, likes: 5, comments: 1, shares: 0, ...extra });
const range = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-18T23:59:59Z") };
const kw = C.buildAqKeywords([]);
const n = (ep) => calls.filter((c) => c.url.includes(ep)).length;
const route = ({ posts, search }) => (ep, p) => ep === "linkedin/company" ? { company_id: 77, name: "Org", followers: 1000 } : ep === "linkedin/company/posts" ? posts(p.page) : ep === "linkedin/posts" ? (search ? search(p.page) : { posts: [] }) : {};
const run = async (s, handle = "org-x") => { script = s; calls.length = 0; const msgs = []; const r = await C.fetchLinkedIn("Org", handle, "k", range, kw, (m) => msgs.push(m)); return { r, msgs }; };

(async () => {
  C.AQ_KEYWORDS_SEARCH.length || require(path.join(__dirname, "..", "src", "pipeline", "frameworks")).setActiveFramework(undefined);

  // the week: 2 air quality posts, 1 off-topic, 1 newer than the window; page 2 is older than the window
  let o = await run(route({ posts: (pg) => pg === 1
    ? { posts: [post(1, "Newest, after the window: air quality", 25), post(2, "Our air quality brief for Delhi", 16), post(3, "Hiring a new analyst", 15), post(4, "PM2.5 monitoring results", 13)] }
    : { posts: [post(5, "Old post about air quality", 2)] } }));
  eq("company posts: counted in window + keyword only", [o.r.postCount, o.r.source, o.r.timelinePages], [2, "timeline", 2]);
  eq("company posts: no keyword search calls at all", [n("linkedin/posts"), n("linkedin/company/posts")], [0, 2]);
  eq("company posts: engagement and tags recorded", [o.r.totalLikes, o.r.topPosts.every((t) => t.keywords_found.length > 0)], [10, true]);

  // no air quality posts in the week -> a genuine zero, still no search
  o = await run(route({ posts: (pg) => pg === 1 ? { posts: [post(6, "Annual report launch", 14), post(7, "Old news", 1)] } : { posts: [] } }));
  eq("company page with no matching posts: 0 from the timeline, search not run", [o.r.postCount, o.r.source, n("linkedin/posts")], [0, "timeline", 0]);

  // hashtag form
  o = await run(route({ posts: (pg) => pg === 1 ? { posts: [post(8, "Breathe easy #CleanAir #AirPollution", 14)] } : { posts: [] } }));
  eq("hashtag-only keyword counts", o.r.postCount, 1);

  // the read fails -> keyword search is used, never a zero
  o = await run(route({ posts: () => { throw new Error("404 not found"); }, search: (pg) => pg === 1 ? { posts: [post(9, "Air quality update", 14)] } : { posts: [] } }));
  eq("read fails: falls back to the keyword search and says so", [o.r.postCount, o.r.source, o.r.searchFallback], [1, "search", true]);

  // the response has no list -> failed read, not "no posts"
  o = await run(route({ posts: () => ({ message: "ok" }), search: (pg) => pg === 1 ? { posts: [post(10, "Smog and air quality", 15)] } : { posts: [] } }));
  eq("response without a post list is a failed read -> fallback", [o.r.postCount, o.r.searchFallback], [1, true]);

  // undated posts cannot be placed in the window -> fallback
  o = await run(route({ posts: (pg) => pg === 1 ? { posts: [{ url: "u1", snippet: "air quality", likes: 1 }, { url: "u2", snippet: "air quality", likes: 1 }] } : { posts: [] }, search: () => ({ posts: [] }) }));
  eq("undated posts -> fallback, not counted", [o.r.postCount, o.r.searchFallback], [0, true]);

  // a repeated page ends the paging
  o = await run(route({ posts: () => ({ posts: [post(11, "air quality", 14), post(12, "smog", 15)] }) }));
  eq("a repeated page is counted once and ends the paging", [o.r.postCount, n("linkedin/company/posts")], [2, 2]);

  // page limit
  let id = 100;
  o = await run(route({ posts: () => ({ posts: [post(id++, "air quality", 14), post(id++, "air quality", 15)] }) }));
  eq("page limit (6) reached inside the window -> flagged", [n("linkedin/company/posts"), o.r.capHit, o.r.postCount], [6, true, 12]);

  // LI_MODE=search keeps the old behaviour
  process.env.LI_MODE = "search";
  o = await run(route({ posts: () => { throw new Error("must not be called"); }, search: (pg) => pg === 1 ? { posts: [post(20, "air quality", 14)] } : { posts: [] } }));
  eq("LI_MODE=search: keyword search only", [o.r.source, o.r.postCount, n("linkedin/company/posts")], ["search", 1, 0]);
  delete process.env.LI_MODE;

  // a person profile has no company page: author search as before
  o = await run(route({ posts: () => { throw new Error("must not be called"); }, search: (pg) => pg === 1 ? { posts: [post(30, "air pollution", 14)] } : { posts: [] } }), "https://www.linkedin.com/in/someone");
  eq("person profile still uses the author search", [o.r.source, n("linkedin/company/posts")], ["search", 0]);

  // cost: a quiet company costs the company lookup + 1-2 post pages, not 21+ searches
  o = await run(route({ posts: (pg) => pg === 1 ? { posts: [post(40, "Hello", 14), post(41, "Older", 1)] } : { posts: [] } }), "https://www.linkedin.com/company/fresh-co");
  eq("calls for a quiet company", calls.length <= 3, true);

  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
