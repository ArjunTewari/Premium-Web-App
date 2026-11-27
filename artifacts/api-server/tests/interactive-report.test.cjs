// Run: node tests/interactive-report.test.cjs. No network, no dependencies.
// The Interactive page as a report: a bar per organisation (scopes in the full report, platforms in a topic report) for posts and for articles, the benchmark
// table with the median over every organisation, only the picked organisations on the page, the top-right tag, and no AEO.
const path = require("path");
const R = require(path.join(__dirname, "..", "src", "pipeline", "interactive-report.js"));
let fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const P = (o, p, s, l = 0) => ({ o, p, s, d: "2026-11-03 10:00:00", t: `${o} ${s} post <b>`, u: `https://x/${o}${s}${p}${l}`, l, c: 0, h: 0, v: 0 });
const ds = {
  dateFrom: "2026-11-02", dateTo: "2026-11-08", orgs: ["A", "B", "C"],
  scopes: [{ id: "air-quality", label: "Air quality" }, { id: "climate", label: "Climate" }, { id: "sustainability", label: "Sustainability" }, { id: "other", label: "Other" }],
  posts: [P("A", "li", "air-quality", 5), P("A", "x", "air-quality", 1), P("A", "ig", "climate", 2), P("B", "li", "sustainability", 3), P("B", "li", "other", 0), P("C", "ig", "air-quality", 9)],
};
const full = R.renderInteractiveReport(ds, { topic: "full" });
const aq = R.renderInteractiveReport(ds, { topic: "air-quality" });
const sel = R.renderInteractiveReport(ds, { topic: "full", orgs: ["A"] });

eq("one bar per organisation for the posts and one for the articles", (full.match(/class="bar"/g) || []).length, 6);
eq("only the picked organisations get a bar, the benchmark table still counts the whole field", [(sel.match(/class="bar"/g) || []).length, sel.includes("Total (all 3 organisations)")], [2, true]);
eq("the full report's total row is every post", /Total \(all 3 organisations\)<\/b><\/td><td class="c">3<\/td><td class="c">1<\/td><td class="c">1<\/td><td class="c">1<\/td><td class="c">6<\/td>/.test(full), true);
eq("a topic report counts only that topic (3 air-quality posts) and pies are by platform", [/Total \(all 3 organisations\)<\/b><\/td><td class="c">3<\/td><td class="c">3<\/td>/.test(aq), aq.includes("LinkedIn") && aq.includes("posts by platform")], [true, true]);
eq("the median is taken over every organisation (full, All column: 3, 2, 1 → 2)", /Median organisation<\/b><\/td>.*<td class="c">2<\/td><\/tr>/.test(full.replace(/\n/g, "")), true);
eq("a picked organisation is compared to the median with an arrow", sel.includes('<tr class="me"><td><b>A</b>'), true);
eq("post text is escaped", [full.includes("A air-quality post &lt;b&gt;"), full.includes("post <b>")], [true, false]);
eq("the page carries the top-right tag with its period", [full.includes('data-emerald-tag="1"'), full.includes("2 Nov – 8 Nov 2026"), aq.includes("Air quality report")], [true, true, true]);
eq("a page with no posts still renders", R.renderInteractiveReport({ ...ds, posts: [] }, {}).includes('<span class="mut">none</span>'), true);
eq("the AI-assistant (AEO) measurement is not used anywhere", /aeo|llm|ai[- ]assistant/i.test(full.replace(/Triple Media Pulse/g, "")), false);
const art = [{ o: "A", k: "tv", x: "NDTV", s: "air-quality", d: "2026-11-03", t: "real", u: "https://n/1" }, { o: "A", k: "press", x: "Mint", s: "climate", d: "2026-11-04", t: "Sample article 1 (placeholder, not a real article)", u: "", z: 1 }];
const withArt = R.renderInteractiveReport({ ...ds, articles: art, articlesSample: true }, { topic: "full" });
eq("articles get their own chart and a sample banner when some are placeholders", [withArt.includes("Press and TV articles by scope"), withArt.includes("Sample data."), full.includes("Sample data.")], [true, true, false]);
eq("a topic report stacks articles by press / TV", R.renderInteractiveReport({ ...ds, articles: art, articlesSample: true }, { topic: "air-quality" }).includes("TV <b>1</b>"), true);
eq("YouTube is a platform", R.renderInteractiveReport({ ...ds, posts: [P("A", "yt", "air-quality", 1)] }, { topic: "air-quality" }).includes("YouTube <b>1</b>"), true);
eq("a bar is a stacked row of segments", R.bars([{ org: "A", total: 3, segs: [{ label: "x", value: 3, colour: "#111" }, { label: "y", value: 0, colour: "#222" }] }]).includes('class="seg"'), true);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
