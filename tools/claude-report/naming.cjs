// Report names:  <Subject>-<Kind>-<Period>-<n>orgs.html
//   Subject  AQ | Climt | Sust
//   Kind     Full | Snap | Bench
//   Period   weekly:  <week of the month>-<Mon><yy>   e.g. 2-Oct26 = 2nd week of October 2026
//            monthly: <Mon><yy>                       e.g. Oct26
//   The week of the month is the week the report STARTS in: start day 1-7 → 1, 8-14 → 2, 15-21 → 3, 22-28 → 4, 29-31 → 5.
//   e.g. AQ-Full-2-Oct26-21orgs.html
const SUBJECTS = { "air-quality": "AQ", climate: "Climt", sustainability: "Sust", AQ: "AQ", Climt: "Climt", Sust: "Sust" };
const KINDS = { full: "Full", snap: "Snap", snapshot: "Snap", bench: "Bench", benchmark: "Bench" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function period(dateFrom, dateTo) {
  const a = new Date(`${dateFrom}T00:00:00Z`), b = new Date(`${dateTo}T00:00:00Z`);
  const days = Math.round((b - a) / 864e5) + 1;
  const yy = String(a.getUTCFullYear()).slice(2), mon = MON[a.getUTCMonth()];
  if (days <= 7) return `${Math.ceil(a.getUTCDate() / 7)}-${mon}${yy}`;
  const lastDay = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate();
  if (a.getUTCDate() === 1 && b.getUTCDate() === lastDay && a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) return `${mon}${yy}`;
  return null; // not a week and not a whole calendar month: the name must be given
}

function reportName({ subject, kind = "Full", dateFrom, dateTo, orgs }) {
  const s = SUBJECTS[subject], k = KINDS[String(kind).toLowerCase()], p = period(dateFrom, dateTo);
  if (!s) throw new Error(`subject must be AQ, Climt or Sust (got ${subject})`);
  if (!k) throw new Error(`kind must be Full, Snap or Bench (got ${kind})`);
  if (!p) throw new Error(`${dateFrom} to ${dateTo} is neither one week nor one whole calendar month: give the name with --name`);
  return `${s}-${k}-${p}-${orgs}orgs.html`;
}

module.exports = { reportName, period };
