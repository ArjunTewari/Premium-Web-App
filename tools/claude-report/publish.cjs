#!/usr/bin/env node
// Step 4 — put the finished report in the web app (the reports repo: reports/<name>.html, reports/<name>.json, manifest.json).
//   node publish.cjs <report-folder> --subject AQ|Climt|Sust [--kind Full|Snap|Bench] [--replace] [--remove <old-name.html>] [--yes]
//   node publish.cjs <report-folder> --name <file.html> ...        (an explicit name instead of the schema, see naming.cjs)
// The name comes from the report's own dates and organisation count: AQ-Full-2-Oct26-21orgs.html.
// Without --yes it only shows what would be written. It refuses to overwrite a report of the same name unless --replace.
// --remove deletes an older copy of the same report (its html, its trend json and its manifest entry) after the new one is in.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REPO, arg, positional } = require("./lib.cjs");
const { reportName } = require("./naming.cjs");

const dir = path.resolve(positional()[0] || "");
const yes = process.argv.includes("--yes"), replace = process.argv.includes("--replace");
const remove = arg("remove");
const fail = (m) => { console.error(m); process.exit(1); };

const htmlFile = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => /\.html$/i.test(f) && !/-client\.html$/i.test(f));
const trendFile = path.join(dir, "trend.json");
if (!htmlFile || !fs.existsSync(trendFile)) fail("the folder needs the report .html and trend.json (build.cjs makes both)");
const html = fs.readFileSync(path.join(dir, htmlFile));
const trend = fs.readFileSync(trendFile);
if (!/name="emerald-audit"/.test(html.toString("utf8"))) fail("refusing: the report has no audit stamp");

let name = arg("name");
if (!name) {
  const t = JSON.parse(trend.toString("utf8"));
  try { name = reportName({ subject: arg("subject"), kind: arg("kind", "Full"), dateFrom: t.dateFrom, dateTo: t.dateTo, orgs: (t.orgs || []).length }); }
  catch (e) { fail(`NOT PUBLISHED: ${e.message}`); }
}
if (!/^[\w.-]+\.html$/.test(name)) fail("the name must be like AQ-Full-2-Oct26-21orgs.html");

const gh = (args, input) => execFileSync("gh", args, { input, maxBuffer: 1 << 28 });
const api = (p) => JSON.parse(gh(["api", `repos/${REPO}/${p}`]).toString());
const sha = (p) => { try { return JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/contents/${p}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }).toString()).sha; } catch { return null; } };
const put = (p, buf, message) => {
  const s = sha(p);
  gh(["api", "-X", "PUT", `repos/${REPO}/contents/${p}`, "--input", "-"], JSON.stringify({ message, content: buf.toString("base64"), branch: "main", ...(s ? { sha: s } : {}) }));
};
const del = (p, message) => { const s = sha(p); if (s) gh(["api", "-X", "DELETE", `repos/${REPO}/contents/${p}`, "--input", "-"], JSON.stringify({ message, sha: s, branch: "main" })); return !!s; };
const editManifest = (fn, message) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = api("contents/manifest.json");
    const next = { reports: fn(JSON.parse(Buffer.from(m.content, "base64").toString("utf8")).reports) };
    try { gh(["api", "-X", "PUT", `repos/${REPO}/contents/manifest.json`, "--input", "-"], JSON.stringify({ message, content: Buffer.from(JSON.stringify(next, null, 2)).toString("base64"), branch: "main", sha: m.sha })); return; }
    catch (e) { if (attempt === 2) throw e; }
  }
};

const dataName = name.replace(/\.html$/i, ".json");
const clash = sha(`reports/${name}`);
console.log(`report   ${htmlFile} → ${REPO}/reports/${name} (${(html.length / 1024).toFixed(0)} KB)${clash ? "  — A REPORT OF THIS NAME EXISTS" : ""}`);
console.log(`trend    trend.json → ${REPO}/reports/${dataName}`);
console.log(`manifest ${REPO}/manifest.json gets an entry for ${name}`);
if (remove) console.log(`remove   ${remove} (html, trend json, manifest entry) after the new one is in`);
if (clash && !replace) fail("\nNOT PUBLISHED: choose another name, or pass --replace to overwrite.");
if (remove && remove === name) fail("\nNOT PUBLISHED: --remove names the report being published.");
if (!yes) { console.log("\nDry run. Add --yes to write."); process.exit(0); }

put(`reports/${name}`, html, `Add report: ${name} (built with Claude Code)`);
put(`reports/${dataName}`, trend, `Add report data: ${name}`);
editManifest((r) => [...r.filter((x) => x.name !== name), { name, size: Math.round(html.length / 1024), mtime: new Date().toISOString().slice(0, 16) }], `Update manifest: ${name}`);
console.log(`\nPUBLISHED ${name}. It appears in the Reports tab and the Trends tab.`);

if (remove) {
  const old = remove.replace(/\.html$/i, "");
  const a = del(`reports/${old}.html`, `Remove report (renamed to ${name}): ${old}.html`);
  const b = del(`reports/${old}.json`, `Remove report data (renamed to ${name}): ${old}.json`);
  editManifest((r) => r.filter((x) => x.name !== `${old}.html`), `Update manifest: remove ${old}.html (renamed to ${name})`);
  console.log(`REMOVED ${old}.html (${a ? "file" : "no file"}, ${b ? "data" : "no data"}, manifest entry)`);
}
