"use strict";
/**
 * Report file names, one scheme for the app and for the Claude Code tools.
 *
 *   Full report:             <Subject>-Full-<Period>-<n>orgs.html     AQ-Full-Wk2-Oct26-21orgs.html
 *   Snapshot / benchmark:    <Subject>-Snap|Bench-<org>-<Period>.html AQ-Snap-cstep-Aug26.html
 *
 *   Subject  AQ | Climt | Sust
 *   Period   weeks:                          Wk<n>-<Mon><yy>                  Wk2-Oct26   (week 2 of October 2026)
 *            several weeks in a row:         Wk<first>-<last>-<Mon><yy>      Wk1-4-Oct26 (weeks 1 to 4 of October 2026)
 *                                            Wk<n><Mon>-Wk<n><Mon><yy>       Wk2Sep-Wk1Oct26 (when they span two months)
 *            whole calendar month(s):        <Mon><yy> | <Mon>-<Mon><yy>     Oct26, Aug-Sep26, Nov25-Feb26
 *            any other window:               <d><Mon>-<d><Mon><yy>           14Sep-11Oct26
 *   A WEEK runs Monday to Sunday. Week 1 of a month is the week that starts on the month's FIRST Monday, week 2 on the
 *   second Monday, and so on (a week belongs to the month its Monday is in: Mon 26 Oct - Sun 1 Nov is week 4 of October).
 *   A window of 7, 14, 21 ... days that starts on a Monday is written in weeks; a window that does not start on a Monday
 *   is not a week and is written out as dates.
 *   A snapshot / benchmark is about one organisation, so the organisation (not "1orgs") is in the name; without it two
 *   snapshots of the same period would overwrite each other.
 */
const SUBJECT_BY_FRAMEWORK = { "air-quality": "AQ", climate: "Climt", sustainability: "Sust" };
const SUBJECTS = ["AQ", "Climt", "Sust"];
const KINDS = { full: "Full", snap: "Snap", snapshot: "Snap", bench: "Bench", benchmark: "Bench" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const subjectOfFramework = (id) => SUBJECT_BY_FRAMEWORK[id] || "AQ";

const DAY = 864e5;
// The n-th Monday of its month is week n: a Monday on the 1st-7th is week 1, the 8th-14th week 2, ... the 29th-31st week 5.
const weekOfMonth = (monday) => Math.ceil(monday.getUTCDate() / 7);

function period(dateFrom, dateTo) {
  const a = new Date(`${dateFrom}T00:00:00Z`), b = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Error(`bad dates ${dateFrom} / ${dateTo}`);
  const days = Math.round((b - a) / DAY) + 1;
  const ay = a.getUTCFullYear(), by = b.getUTCFullYear(), yy = (y) => String(y).slice(2);
  const am = MON[a.getUTCMonth()], bm = MON[b.getUTCMonth()];
  const lastDay = new Date(Date.UTC(by, b.getUTCMonth() + 1, 0)).getUTCDate();
  if (a.getUTCDate() === 1 && b.getUTCDate() === lastDay) {
    if (ay === by && am === bm) return `${am}${yy(ay)}`;
    return ay === by ? `${am}-${bm}${yy(by)}` : `${am}${yy(ay)}-${bm}${yy(by)}`;
  }
  if (a.getUTCDay() === 1 && days % 7 === 0) {
    const n = days / 7;
    const last = new Date(a.getTime() + (n - 1) * 7 * DAY); // the Monday of the last week
    const w1 = weekOfMonth(a), w2 = weekOfMonth(last), lm = MON[last.getUTCMonth()], ly = last.getUTCFullYear();
    if (n === 1) return `Wk${w1}-${am}${yy(ay)}`;
    if (ay === ly && a.getUTCMonth() === last.getUTCMonth()) return `Wk${w1}-${w2}-${am}${yy(ay)}`;
    return ay === ly ? `Wk${w1}${am}-Wk${w2}${lm}${yy(ly)}` : `Wk${w1}${am}${yy(ay)}-Wk${w2}${lm}${yy(ly)}`;
  }
  return ay === by ? `${a.getUTCDate()}${am}-${b.getUTCDate()}${bm}${yy(by)}` : `${a.getUTCDate()}${am}${yy(ay)}-${b.getUTCDate()}${bm}${yy(by)}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function reportName({ subject = "AQ", kind = "Full", dateFrom, dateTo, orgs, org }) {
  const s = SUBJECTS.find((x) => x.toLowerCase() === String(subject).toLowerCase()) || SUBJECT_BY_FRAMEWORK[subject];
  const k = KINDS[String(kind).toLowerCase()];
  if (!s) throw new Error(`subject must be AQ, Climt or Sust (got ${subject})`);
  if (!k) throw new Error(`kind must be Full, Snap or Bench (got ${kind})`);
  const p = period(dateFrom, dateTo);
  if (k === "Full") return `${s}-Full-${p}-${orgs}orgs.html`;
  if (!org) throw new Error("a snapshot or benchmark needs the organisation");
  return `${s}-${k}-${slug(org)}-${p}.html`;
}

/** "Snap" / "Bench" files, new or legacy (aq-snapshot-…); null for a full report. */
const DERIVED_NAME = /^(?:(?:aq|climt|sust)-(bench|snap)-|aq-(benchmark|snapshot)-)/i;
function derivedKindOfName(name) {
  const m = DERIVED_NAME.exec(String(name));
  if (!m) return null;
  return /^b/i.test(m[1] || m[2]) ? "benchmark" : "snapshot";
}

/** The subject code a stored name starts with (new or legacy TMP-/aq- names). */
function subjectOfName(name) {
  const m = /^(AQ|Climt|Sust)-/i.exec(String(name));
  if (m) return SUBJECTS.find((x) => x.toLowerCase() === m[1].toLowerCase());
  if (/^TMP-Climate-/i.test(name)) return "Climt";
  if (/^TMP-Sust/i.test(name)) return "Sust";
  return "AQ";
}

/**
 * The current name of a report that was stored under an older scheme (aq-snapshot-<org>-<from>-to-<to>.html, or the
 * week-number-without-"Wk" names), so records
 * that still carry the old file name (the run log's cost) can be matched to the renamed file. Full reports cannot be
 * derived from their old name (it has no dates); a name already in the new scheme is returned unchanged.
 */
function currentName(name) {
  // the scheme before weeks were written "Wk": ...-2-Oct26-... (a week of the month, no "Wk")
  const prev = /^((?:AQ|Climt|Sust)-(?:Full|Snap|Bench)-(?:.*-)?)([1-5])-([A-Z][a-z]{2}\d\d)((?:-\d+orgs)?\.html)$/.exec(String(name));
  if (prev) return `${prev[1]}Wk${prev[2]}-${prev[3]}${prev[4]}`;
  const d = /^aq-(snapshot|benchmark)-(.+)-(\d{4}-\d\d-\d\d)-to-(\d{4}-\d\d-\d\d)\.html$/i.exec(String(name));
  if (!d) return name;
  try { return reportName({ subject: "AQ", kind: d[1], dateFrom: d[3], dateTo: d[4], org: d[2] }); } catch { return name; }
}

module.exports = { reportName, period, slug, subjectOfFramework, derivedKindOfName, subjectOfName, currentName, DERIVED_NAME };
