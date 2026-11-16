// Run: node tests/naming.test.cjs. No network, no dependencies.
// Report file names: <Subject>-Full-<period>-<n>orgs / <Subject>-Snap|Bench-<org>-<period>.
const path = require("path");
const N = require(path.join(__dirname, "..", "src", "pipeline", "report-naming.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };
const full = (a, b, n, subject = "AQ") => N.reportName({ subject, kind: "Full", dateFrom: a, dateTo: b, orgs: n });

eq("a week is Monday to Sunday; week 1 starts on the month's first Monday", [full("2026-11-02", "2026-11-08", 21), full("2026-10-12", "2026-10-18", 21), full("2026-10-19", "2026-10-25", 21), full("2026-10-26", "2026-11-01", 21)],
  ["AQ-Full-Wk1-Nov26-21orgs.html", "AQ-Full-Wk2-Oct26-21orgs.html", "AQ-Full-Wk3-Oct26-21orgs.html", "AQ-Full-Wk4-Oct26-21orgs.html"]);
eq("a Monday on the 29th-31st starts week 5", full("2026-12-28", "2027-01-03", 3), "AQ-Full-Wk4-Dec26-3orgs.html");
eq("week 5 exists when a month has five Mondays", full("2026-11-30", "2026-12-06", 3), "AQ-Full-Wk5-Nov26-3orgs.html");
eq("the first Monday decides week 1 (Oct 2026: the 1st is a Thursday, the first Monday is the 5th)", [full("2026-10-05", "2026-10-11", 21), full("2026-09-28", "2026-10-04", 21)], ["AQ-Full-Wk1-Oct26-21orgs.html", "AQ-Full-Wk4-Sep26-21orgs.html"]);
eq("four weeks in a row", [full("2026-10-05", "2026-11-01", 21), full("2026-09-07", "2026-10-04", 21)], ["AQ-Full-Wk1-4-Oct26-21orgs.html", "AQ-Full-Wk1-4-Sep26-21orgs.html"]);
eq("weeks that span two months", [full("2026-09-14", "2026-10-11", 21), full("2026-12-21", "2027-01-17", 2)], ["AQ-Full-Wk2Sep-Wk1Oct26-21orgs.html", "AQ-Full-Wk3Dec26-Wk2Jan27-2orgs.html"]);
eq("a 7-day window that does not start on a Monday is not a week", full("2026-10-22", "2026-10-28", 1), "AQ-Full-22Oct-28Oct26-1orgs.html");
eq("whole calendar months", [full("2026-10-01", "2026-10-31", 20), full("2026-08-01", "2026-09-30", 20), full("2025-11-01", "2026-02-28", 5)],
  ["AQ-Full-Oct26-20orgs.html", "AQ-Full-Aug-Sep26-20orgs.html", "AQ-Full-Nov25-Feb26-5orgs.html"]);
eq("any other window is written out", [full("2026-09-11", "2026-10-11", 20), full("2026-02-01", "2026-05-01", 13), full("2025-12-20", "2026-01-10", 2)],
  ["AQ-Full-11Sep-11Oct26-20orgs.html", "AQ-Full-1Feb-1May26-13orgs.html", "AQ-Full-20Dec25-10Jan26-2orgs.html"]);
eq("subjects", [full("2026-10-12", "2026-10-18", 3, "Climt"), N.subjectOfFramework("climate"), N.subjectOfFramework("sustainability"), N.subjectOfFramework("air-quality"), N.subjectOfFramework("nope")], ["Climt-Full-Wk2-Oct26-3orgs.html", "Climt", "Sust", "AQ", "AQ"]);
eq("a snapshot / benchmark names the organisation, not '1orgs'", [
  N.reportName({ subject: "AQ", kind: "snapshot", dateFrom: "2026-08-01", dateTo: "2026-08-31", org: "CSTEP" }),
  N.reportName({ subject: "AQ", kind: "benchmark", dateFrom: "2026-08-01", dateTo: "2026-08-31", org: "Chintan Environmental Research and Action Group" }),
  N.reportName({ subject: "Climt", kind: "Snap", dateFrom: "2026-10-12", dateTo: "2026-10-18", org: "WRI India" }),
], ["AQ-Snap-cstep-Aug26.html", "AQ-Bench-chintan-environmental-research-and-action-group-Aug26.html", "Climt-Snap-wri-india-Wk2-Oct26.html"]);
eq("two snapshots of one period do not collide", N.reportName({ kind: "snap", dateFrom: "2026-10-12", dateTo: "2026-10-18", org: "CREA" }) !== N.reportName({ kind: "snap", dateFrom: "2026-10-12", dateTo: "2026-10-18", org: "CSTEP" }), true);
eq("a snapshot without an organisation is refused", (() => { try { N.reportName({ kind: "snap", dateFrom: "2026-10-12", dateTo: "2026-10-18" }); return "made"; } catch (e) { return "refused"; } })(), "refused");
eq("type of a stored name, new and older", ["AQ-Full-Wk2-Oct26-21orgs.html", "AQ-Snap-cstep-Aug26.html", "Sust-Bench-x-Oct26.html", "aq-snapshot-cstep-2026-08-01-to-2026-08-31.html", "aq-benchmark-x-2026-08-01-to-2026-08-31.html", "TMP-Sep2026-20orgs.html"].map(N.derivedKindOfName),
  [null, "snapshot", "benchmark", "snapshot", "benchmark", null]);
eq("subject of a stored name", ["AQ-Full-Wk2-Oct26-21orgs.html", "Climt-Snap-x-Oct26.html", "TMP-Climate-Sep-Oct2026-3orgs.html", "TMP-Sep2026-20orgs.html"].map(N.subjectOfName), ["AQ", "Climt", "Climt", "AQ"]);
eq("a report stored under the older scheme is matched to its current name", [
  N.currentName("aq-snapshot-cstep-2026-08-01-to-2026-08-31.html"),
  N.currentName("aq-benchmark-chintan-environmental-research-and-action-group-2026-08-01-to-2026-08-31.html"),
  N.currentName("aq-snapshot-raahgiri-2026-09-07-to-2026-09-13.html"),
  N.currentName("AQ-Snap-cstep-Aug26.html"),
  N.currentName("TMP-Sep2026-20orgs.html"),
  N.currentName("AQ-Snap-raahgiri-2-Oct26.html"),
  N.currentName("AQ-Full-4-Sep26-21orgs.html"),
  N.currentName("AQ-Full-Wk4-Sep26-21orgs.html"),
  N.currentName("AQ-Snap-cstep-1Feb-1May26.html"),
], ["AQ-Snap-cstep-Aug26.html", "AQ-Bench-chintan-environmental-research-and-action-group-Aug26.html", "AQ-Snap-raahgiri-Wk1-Sep26.html", "AQ-Snap-cstep-Aug26.html", "TMP-Sep2026-20orgs.html",
  "AQ-Snap-raahgiri-Wk2-Oct26.html", "AQ-Full-Wk4-Sep26-21orgs.html", "AQ-Full-Wk4-Sep26-21orgs.html", "AQ-Snap-cstep-1Feb-1May26.html"]);
eq("names are safe file names", /^[\w.-]+$/.test(full("2026-09-14", "2026-10-11", 20)), true);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
