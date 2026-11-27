// Run: node tests/report-tag.test.cjs. No network, no dependencies.
// Every report carries a top-right tag with its kind and period; clicking it goes to the top; adding it twice changes nothing.
const path = require("path");
const T = require(path.join(__dirname, "..", "src", "pipeline", "report-tag.js"));
let fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const full = '<!DOCTYPE html><html><head><title>x</title></head><body><div class="edit-bar" id="edit-bar"><span>21 orgs</span></div><main><header id="header"><div class="rm">Period: 2026-11-02 &rarr; 2026-11-08 &middot; Sun</div></header></main></body></html>';
const bench = '<!DOCTYPE html><html><head><meta name="emerald-report-type" content="benchmark"><title>b</title></head><body><main><div class="rm">Period 2026-10-05 to 2026-11-01 &middot; one organisation</div></main></body></html>';

eq("the period is read from a full report and a benchmark", [T.periodOf(full), T.periodOf(bench)], [{ from: "2026-11-02", to: "2026-11-08" }, { from: "2026-10-05", to: "2026-11-01" }]);
eq("periods are written for people", [T.formatPeriod("2026-11-02", "2026-11-08"), T.formatPeriod("2026-12-28", "2027-01-03"), T.formatPeriod("x", "y")], ["2 Nov – 8 Nov 2026", "28 Dec 2026 – 3 Jan 2027", ""]);
eq("the kind is read from the page", [T.kindOf(full), T.kindOf(bench), T.kindOf(bench.replace("benchmark", "snapshot"))], ["Full report", "Benchmark", "Snapshot"]);

const a = T.injectReportTag(full);
eq("the full report's tag sits in its top-right bar, with the kind and the period", [a.indexOf('<div class="edit-bar" id="edit-bar"><a href="#" class="etag"') >= 0, a.includes("Full report <span class=\"etag-p\">· 2 Nov – 8 Nov 2026</span>")], [true, true]);
eq("clicking it scrolls to the top", [a.includes('onclick="emeraldTop(event)"'), a.includes("function emeraldTop")], [true, true]);
const b = T.injectReportTag(bench);
eq("a page without the bar gets a fixed tag in the corner", [b.includes('class="etag etag-fixed"'), b.includes("Benchmark <span class=\"etag-p\">· 5 Oct – 1 Nov 2026</span>")], [true, true]);
eq("adding it twice changes nothing", [T.injectReportTag(a) === a, T.injectReportTag(b) === b], [true, true]);
eq("a page with no period still gets the kind", T.injectReportTag("<html><head></head><body><p>hi</p></body></html>").includes(">Full report</a>"), true);
eq("the tag is hidden in print and the page stays whole", [a.includes("@media print{.etag{display:none!important}}"), a.endsWith("</body></html>") || a.includes("</script></body></html>")], [true, true]);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
