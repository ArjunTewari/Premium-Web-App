#!/usr/bin/env node
// Make a Benchmark or Snapshot of ONE organisation from a full report that is already built (free: no fetching, no AI call).
// It is the same code the web app runs for "◧ Benchmark / Snapshot" on a report in the Reports tab.
//   node derive.cjs <full-report.html> --org <name> [--type benchmark|snapshot] [--from YYYY-MM-DD --to YYYY-MM-DD]
//                   [--out dir] [--yes]
//   --type    benchmark (default): the whole period of the full report. snapshot: the first scorecard only; --from/--to may
//             pick a shorter window inside the report's period (benchmarks always cover the whole period).
//   --out     where the file is written (default ./work/derived). The name follows the scheme: AQ-Bench-raahgiri-Wk1-4-Oct26.html
//   --yes     also puts it in the web app (reports/<name> and the manifest) with the client-facing price the app draws for this type
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib.cjs");
const N = require("./naming.cjs");

const file = L.positional()[0];
const org = L.arg("org"), type = String(L.arg("type", "benchmark")).toLowerCase();
const fail = (m) => { console.error("NOT MADE: " + m); process.exit(1); };
if (!file || !org) fail("usage: node derive.cjs <full-report.html> --org <name> [--type benchmark|snapshot] [--from d --to d] [--out dir] [--yes]");
if (!["benchmark", "snapshot"].includes(type)) fail("--type must be benchmark or snapshot");

const dash = require(path.join(L.PIPE, "single-org-dashboard.js"));
const html = fs.readFileSync(file, "utf8");
if (/<meta name="emerald-report-type" content="(benchmark|snapshot)">/i.test(html.slice(0, 4000))) fail("that file is already a benchmark/snapshot; start from a full report");
const base = dash.parseBaseReport(html);
const subject = base.orgs.find((o) => o.toLowerCase() === org.trim().toLowerCase());
if (!subject) fail(`"${org}" is not in this report. Organisations: ${base.orgs.join("; ")}`);
const from = L.arg("from"), to = L.arg("to");
if ((from || to) && type !== "snapshot") fail("a shorter period is for snapshots only");
const range = from && to ? { from, to } : undefined;

let profile;
const pf = path.join(L.PIPE, "single-org-profiles", `${subject.toLowerCase()}.json`);
if (fs.existsSync(pf)) profile = JSON.parse(fs.readFileSync(pf, "utf8"));

const out = dash.buildSingleOrgDashboard(html, { org: subject, view: type, ...(profile ? { profile } : {}), ...(range ? { range } : {}) });
const fw = (/<meta name="emerald-framework" content="([a-z-]+)"/.exec(html.slice(0, 20000)) || [])[1] || "air-quality";
const name = N.reportName({ subject: N.subjectOfFramework(fw), kind: type, dateFrom: range ? range.from : base.meta.from, dateTo: range ? range.to : base.meta.to, org: subject });
const dir = path.resolve(L.arg("out", path.join("work", "derived")));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, name), out);
console.log(`${type} for ${subject}, ${range ? range.from : base.meta.from} to ${range ? range.to : base.meta.to} → ${path.join(dir, name)} (${(out.length / 1024).toFixed(0)} KB)`);

if (!process.argv.includes("--yes")) { console.log("\nNot put in the web app. Add --yes to do that."); process.exit(0); }
const gh = (args, input) => execFileSync("gh", args, { input, maxBuffer: 1 << 28 });
const api = (p) => JSON.parse(gh(["api", `repos/${L.REPO}/${p}`]).toString());
const existing = (() => { try { return api(`contents/reports/${name}`).sha; } catch { return null; } })();
if (existing && !process.argv.includes("--replace")) fail(`${name} is already in the web app (pass --replace to overwrite it)`);
// the client-facing price the app draws for a derived report (see lib/report-types.ts DERIVED_PRICE_RANGE_INR)
const RANGE = { snapshot: [40, 45], benchmark: [90, 100] }[type];
const priceInr = Math.round((RANGE[0] + Math.random() * (RANGE[1] - RANGE[0])) * 100) / 100;
gh(["api", "-X", "PUT", `repos/${L.REPO}/contents/reports/${name}`, "--input", "-"], JSON.stringify({ message: `Add ${type}: ${name} (derived from ${path.basename(file)})`, content: Buffer.from(out).toString("base64"), branch: "main", ...(existing ? { sha: existing } : {}) }));
for (let attempt = 0; attempt < 3; attempt++) {
  const m = api("contents/manifest.json");
  const reports = JSON.parse(Buffer.from(m.content, "base64").toString("utf8")).reports.filter((x) => x.name !== name);
  reports.push({ name, size: Math.round(out.length / 1024), mtime: new Date().toISOString().slice(0, 16), priceInr });
  try { gh(["api", "-X", "PUT", `repos/${L.REPO}/contents/manifest.json`, "--input", "-"], JSON.stringify({ message: `Update manifest: ${name}`, content: Buffer.from(JSON.stringify({ reports }, null, 2)).toString("base64"), branch: "main", sha: m.sha })); break; }
  catch (e) { if (attempt === 2) throw e; }
}
console.log(`PUT IN THE WEB APP ${name} (price shown to the client ₹${priceInr.toFixed(2)}).`);
