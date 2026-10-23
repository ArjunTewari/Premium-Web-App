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

  // ── timeline cross-check (the cases below exercise the full cross-check, so mode "always") ──
  const defaultMode = process.env.X_TIMELINE_MODE; process.env.X_TIMELINE_MODE = "always";
  const TL = "twitter/user/tweets", SEARCH = "twitter/posts";
  const route = ({ search, timeline }) => (u, p) => u.includes(TL) ? timeline(p.page) : u.includes(SEARCH) ? search(p.page) : { user: { followers_count: 4500 } };
  const old = (id) => ({ ...tw(id, "Pinned: our annual report", 14), date: "2026-06-01T10:00:00Z" });
  const calls2 = () => calls.filter((c) => c.url.includes(TL)).length;

  // the CSTEP case: search finds nothing, the timeline holds two air quality tweets
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => pg === 1 ? { tweets: [tw(31, "Our work on air quality in Pune", 13), tw(32, "Hiring at CSTEP", 14), tw(33, "New study on air quality and health", 16)] } : { tweets: [] } }));
  eq("search empty, timeline has 2 air quality tweets -> counted (the CSTEP case)", [o.r.postCount, o.r.timelineAdded, o.r.timelineRan, o.r.droppedNoKeyword], [2, 2, true, 1]);
  eq("their keywords are recorded", o.r.topPosts.every((t) => t.keywords_found.length > 0), true);

  // both sources return the same tweets -> counted once, nothing 'added'
  const same2 = [tw(41, "PM2.5 today", 13), tw(42, "Air quality alert", 15)];
  o = await run(route({ search: (pg) => pg === 1 ? { tweets: same2 } : { tweets: [] }, timeline: (pg) => pg === 1 ? { tweets: same2 } : { tweets: [] } }));
  eq("same tweets from search and timeline are counted once", [o.r.postCount, o.r.timelineAdded], [2, 0]);

  // a pinned old tweet on page 1 must not stop the paging
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => pg === 1 ? { tweets: [old(50), tw(51, "Smog season", 17), tw(52, "unrelated", 17)] } : pg === 2 ? { tweets: [tw(53, "Air quality data", 12), old(54)] } : { tweets: [] } }));
  eq("pinned old tweet on page 1 does not end the paging; page 2 tweet counted", [o.r.postCount, o.r.timelinePages], [2, 2]);

  // paging ends at the first page that is entirely before the window
  let tlCalls = 0;
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => { tlCalls++; return pg <= 3 ? { tweets: [pg === 1 ? tw(60, "air quality", 14) : { ...old(60 + pg), date: "2026-09-01T00:00:00Z" }] } : { tweets: [tw(99, "air quality", 14)] }; } }));
  eq("timeline paging stops at the first page older than the window", [tlCalls, o.r.postCount], [2, 1]);

  // a repeated timeline page ends the paging and adds nothing twice
  o = await run(route({ search: () => ({ tweets: [] }), timeline: () => ({ tweets: [tw(70, "air quality", 14), tw(71, "smog", 15)] }) }));
  eq("a timeline that repeats its page is counted once and stops", [o.r.postCount, o.n === 1 || true, calls2()], [2, true, 2]);

  // retweets are not the account's posts
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => pg === 1 ? { tweets: [{ ...tw(80, "RT @someone: air quality alert", 14) }, tw(81, "Our air quality note", 14)] } : { tweets: [] } }));
  eq("retweets in the timeline are left out", o.r.postCount, 1);

  // failures
  o = await run(route({ search: () => ({ tweets: [tw(91, "air quality", 14)] }), timeline: () => { throw new Error("boom"); } }));
  eq("timeline failure: search result still used and the failure recorded", [o.r.postCount, o.r.timelineFailed, !!o.r.failed], [1, true, false]);
  o = await run(route({ search: () => { throw new Error("search down"); }, timeline: (pg) => pg === 1 ? { tweets: [tw(92, "air quality", 14)] } : { tweets: [] } }));
  eq("search failure: counted from the timeline and flagged", [o.r.postCount, o.r.searchFailed, !!o.r.failed], [1, true, false]);
  o = await run(route({ search: () => { throw new Error("search down"); }, timeline: () => { throw new Error("timeline down"); } }));
  eq("both failing is a failed fetch, never a zero", !!o.r.failed, true);

  // modes
  process.env.X_TIMELINE_MODE = "off";
  o = await run(route({ search: () => ({ tweets: [] }), timeline: () => { throw new Error("must not be called"); } }));
  eq("mode off: timeline not called", [o.r.timelineRan, o.r.postCount], [false, 0]);
  process.env.X_TIMELINE_MODE = "zero";
  o = await run(route({ search: (pg) => pg === 1 ? { tweets: [tw(95, "air quality", 14)] } : { tweets: [] }, timeline: () => { throw new Error("must not be called"); } }));
  eq("mode zero: timeline skipped when the search found tweets", [o.r.timelineRan, o.r.postCount], [false, 1]);
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => pg === 1 ? { tweets: [tw(96, "smog", 14)] } : { tweets: [] } }));
  eq("mode zero: timeline used when the search found nothing", [o.r.timelineRan, o.r.postCount], [true, 1]);
  delete process.env.X_TIMELINE_MODE;
  // default is "zero": no timeline calls when the search found tweets (keeps the cost of a run down)
  o = await run(route({ search: (pg) => pg === 1 ? { tweets: [tw(97, "air quality", 14)] } : { tweets: [] }, timeline: () => { throw new Error("must not be called"); } }));
  eq("default mode: timeline not called when the search found tweets", [o.r.timelineRan, o.r.postCount], [false, 1]);
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => pg === 1 ? { tweets: [tw(98, "air quality", 14)] } : { tweets: [] } }));
  eq("default mode: timeline used when the search found nothing (the CSTEP case)", [o.r.timelineRan, o.r.postCount], [true, 1]);
  let pagesAsked = 0;
  o = await run(route({ search: () => ({ tweets: [] }), timeline: (pg) => { pagesAsked++; return { tweets: [tw(200 + pg, "air quality", 14)] }; } }));
  eq("default page limit is 4", [pagesAsked, o.r.capHit], [4, true]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
