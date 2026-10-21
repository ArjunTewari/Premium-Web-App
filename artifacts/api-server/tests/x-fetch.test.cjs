// Run: node tests/x-fetch.test.cjs  (needs the app's node_modules). Scripted fake API; no network.
const Module = require("module"); const path = require("path");
let script = null; const calls = [];
const fakeAxios = { get: async (url, { params }) => { calls.push({ url, params }); return { data: script(url, params) }; } };
const orig = Module._load;
Module._load = function (req, ...a) { if (req === "axios") return fakeAxios; return orig.call(this, req, ...a); };
const C = require(path.join(__dirname, "..", "src", "pipeline", "apidirect-collector.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };
const day = (d) => `2026-10-${String(d).padStart(2, "0")}T10:00:00Z`;
const tw = (id, text, d = 14) => ({ id: String(id), text, date: day(d), likes: 1, replies: 0, retweets: 0, views: 10, url: `https://twitter.com/CREACleanAir/status/${id}` });
const range = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-18T23:59:59Z") };
const kw = C.buildAqKeywords([]);
const run = async (s) => { script = s; calls.length = 0; const msgs = []; const r = await C.fetchTwitter("CREA", "CREACleanAir", "k", range, kw, (m) => msgs.push(m)); return { r, msgs, n: calls.filter(c => c.url.includes("twitter/posts")).length }; };
(async () => {
  // 1. the fault: every page returns the same 20 tweets
  const same = Array.from({ length: 20 }, (_, i) => tw(1000 + i, i === 0 ? "India Quarterly Energy Snapshot: electricity generation up 11%" : `PM2.5 update number ${i} for Delhi`));
  let o = await run((u) => u.includes("twitter/posts") ? { tweets: same } : { user: { followers_count: 8100 } });
  eq("repeated pages: 19 unique keyword tweets, not 100", [o.r.postCount, o.r.duplicatesRemoved > 0, o.n], [19, true, 2]);
  eq("repeated pages: no tweet appears twice in top posts", new Set(o.r.topPosts.map(p => p.url)).size, o.r.topPosts.length);
  eq("the off-topic energy tweet is dropped (no keyword in its text)", [o.r.droppedNoKeyword, o.r.topPosts.every(p => p.keywords_found.length > 0)], [1, true]);
  eq("paging stops as soon as a page adds nothing", o.n, 2);
  // 2. genuine 5 pages x 20 distinct, all on topic -> counted, flagged as possibly truncated
  let id = 5000; o = await run((u, p) => u.includes("twitter/posts") ? { tweets: Array.from({ length: 20 }, () => tw(id++, "Delhi air quality AQI today")) } : { user: { followers_count: 8100 } });
  eq("genuine 100 distinct tweets: counted, cap flagged", [o.r.postCount, o.r.capHit, o.r.duplicatesRemoved], [100, true, 0]);
  // 3. small normal result
  o = await run((u, p) => u.includes("twitter/posts") ? { tweets: p.page === 1 ? [tw(1, "NCAP funding for clean air"), tw(2, "Smog in Delhi")] : [] } : { user: { followers_count: 8100 } });
  eq("normal small result unchanged", [o.r.postCount, o.r.capHit, o.r.duplicatesRemoved, o.r.droppedNoKeyword], [2, false, 0, 0]);
  eq("normal small result: engagement totals", [o.r.totalLikes], [2]);
  // 4. hashtag form still counts
  o = await run((u) => u.includes("twitter/posts") ? { tweets: [tw(7, "Breathe easy #CleanAir #AirPollution")] } : { user: { followers_count: 1 } });
  eq("hashtag-only keyword still counts", o.r.postCount, 1);
  // 5. nothing returned
  o = await run((u) => u.includes("twitter/posts") ? { tweets: [] } : { user: { followers_count: 1 } });
  eq("empty search -> 0, no cap flag", [o.r.postCount, o.r.capHit], [0, false]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
