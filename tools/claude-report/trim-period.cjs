#!/usr/bin/env node
// Cut a saved collection down to a shorter period inside the one it covers (e.g. the last week of a longer run).
//   node trim-period.cjs <collection.json.gz> --from YYYY-MM-DD --to YYYY-MM-DD --out <trimmed.json.gz>
// Articles and YouTube videos outside the period are dropped (their classification goes with them); the saved social posts are
// kept whole and are counted for the new period by the app's own re-count when the report is built. The AI-assistant probes are
// a measurement on the day of collection and are not touched. Nothing is fetched.
const fs = require("fs");
const L = require("./lib.cjs");
L.useAppModules();
const CP = L.pipe("checkpoint.js");

const file = L.positional()[0], from = L.arg("from"), to = L.arg("to"), out = L.arg("out");
const fail = (m) => { console.error("NOT TRIMMED: " + m); process.exit(1); };
if (!file || !from || !to || !out) fail("usage: node trim-period.cjs <collection.json.gz> --from YYYY-MM-DD --to YYYY-MM-DD --out <trimmed.json.gz>");
const chk = CP.unpack(fs.readFileSync(file));
const fp = chk.fingerprint;
if (from < fp.dateFrom || to > fp.dateTo || from > to) fail(`the period must lie inside the collection's ${fp.dateFrom} to ${fp.dateTo}`);
const inWin = (d) => { const t = String(d || "").slice(0, 10); return t >= from && t <= to; };

const arts = {}, cls = {};
let dropped = 0, kept = 0;
for (const org of fp.orgs) {
  arts[org] = []; cls[org] = [];
  const a = chk.state.arts[org] || [], k = chk.state.cls[org] || [];
  a.forEach((art, i) => {
    if (art.date && !inWin(art.date)) { dropped++; return; }
    const n = arts[org].length; arts[org].push(art); kept++;
    const c = k.find((x) => x.index === i);
    if (c) cls[org].push({ ...c, index: n });
  });
}
const exaWhiteSpace = (chk.state.exaWhiteSpace || []).filter((a) => !a.date || inWin(a.date));

const youtubeERResults = chk.state.youtubeERResults.map((r) => {
  const videos = (r.videos || []).filter((v) => inWin(v.publishedAt));
  const subER = videos.filter((v) => v.subscriberER !== null && v.subscriberER !== undefined), viewER = videos.filter((v) => v.viewER !== null && v.viewER !== undefined);
  const mean = (xs, f) => (xs.length ? parseFloat((xs.reduce((s, v) => s + Number(f(v)), 0) / xs.length).toFixed(3)) : 0);
  const sum = (f) => videos.reduce((s, v) => s + (Number(f(v)) || 0), 0);
  return { ...r, videos, videoCount: videos.length, avgER: mean(subER, (v) => v.subscriberER), avgViewER: mean(viewER, (v) => v.viewER),
    erMethod: subER.length ? "subscriber" : viewER.length ? "view" : "none", totalViews: sum((v) => v.views), totalLikes: sum((v) => v.likes), totalComments: sum((v) => v.comments) };
});
youtubeERResults.sort((a, b) => (b.avgER - a.avgER) || (b.avgViewER - a.avgViewER) || (b.videoCount - a.videoCount));
youtubeERResults.forEach((r, i) => { r.rank = i + 1; });

fs.writeFileSync(out, CP.pack({ ...fp, dateFrom: from, dateTo: to }, { ...chk.state, arts, cls, exaWhiteSpace, youtubeERResults }, chk.cost));
console.log(`trimmed ${fp.dateFrom}..${fp.dateTo} → ${from}..${to}: ${kept} articles kept, ${dropped} dropped → ${out}`);
