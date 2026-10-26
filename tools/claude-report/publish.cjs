#!/usr/bin/env node
// Step 4 — put the finished report in the web app (the reports repo: reports/<name>.html, reports/<name>.json, manifest.json).
//   node publish.cjs <report-folder> --name <TMP-....html> [--replace] [--yes]
// Without --yes it only shows what would be written. It refuses to overwrite a report of the same name unless --replace.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REPO, arg, positional } = require("./lib.cjs");

const dir = path.resolve(positional()[0] || "");
const name = arg("name");
const yes = process.argv.includes("--yes"), replace = process.argv.includes("--replace");
if (!dir || !name || !/^[\w.-]+\.html$/.test(name)) { console.error("usage: node publish.cjs <report-folder> --name <file.html> [--replace] [--yes]"); process.exit(1); }

const htmlFile = fs.readdirSync(dir).find((f) => /\.html$/i.test(f) && !/-client\.html$/i.test(f));
const trendFile = path.join(dir, "trend.json");
if (!htmlFile || !fs.existsSync(trendFile)) { console.error("the folder needs the report .html and trend.json (build.cjs makes both)"); process.exit(1); }
const html = fs.readFileSync(path.join(dir, htmlFile));
const trend = fs.readFileSync(trendFile);
if (!/name="emerald-audit"/.test(html.toString("utf8"))) { console.error("refusing: the report has no audit stamp"); process.exit(1); }

const gh = (args, input) => execFileSync("gh", args, { input, maxBuffer: 1 << 28 });
const api = (p, extra = []) => JSON.parse(gh(["api", `repos/${REPO}/${p}`, ...extra]).toString());
const exists = (p) => { try { return api(`contents/${p}`).sha; } catch { return null; } };
const put = (p, buf, message) => {
  const sha = exists(p);
  const body = JSON.stringify({ message, content: buf.toString("base64"), branch: "main", ...(sha ? { sha } : {}) });
  gh(["api", "-X", "PUT", `repos/${REPO}/contents/${p}`, "--input", "-"], body);
};

const dataName = name.replace(/\.html$/i, ".json");
const clash = exists(`reports/${name}`);
console.log(`report   ${htmlFile} → ${REPO}/reports/${name} (${(html.length / 1024).toFixed(0)} KB)${clash ? "  — A REPORT OF THIS NAME EXISTS" : ""}`);
console.log(`trend    trend.json → ${REPO}/reports/${dataName}`);
console.log(`manifest ${REPO}/manifest.json gets an entry for ${name}`);
if (clash && !replace) { console.error("\nNOT PUBLISHED: choose another --name, or pass --replace to overwrite."); process.exit(1); }
if (!yes) { console.log("\nDry run. Add --yes to write."); process.exit(0); }

put(`reports/${name}`, html, `Add report: ${name} (built with Claude Code)`);
put(`reports/${dataName}`, trend, `Add report data: ${name}`);
for (let attempt = 0; attempt < 3; attempt++) {
  const m = api("contents/manifest.json");
  const manifest = JSON.parse(Buffer.from(m.content, "base64").toString("utf8"));
  const next = { reports: [...manifest.reports.filter((r) => r.name !== name), { name, size: Math.round(html.length / 1024), mtime: new Date().toISOString().slice(0, 16) }] };
  try {
    gh(["api", "-X", "PUT", `repos/${REPO}/contents/manifest.json`, "--input", "-"],
      JSON.stringify({ message: `Update manifest: ${name}`, content: Buffer.from(JSON.stringify(next, null, 2)).toString("base64"), branch: "main", sha: m.sha }));
    console.log(`\nPUBLISHED ${name}. It appears in the Reports tab and the Trends tab.`);
    process.exit(0);
  } catch (e) { if (attempt === 2) throw e; }
}
