#!/usr/bin/env node
// One-off: give every report already in the reports repo its name under the current scheme (pipeline/report-naming.js).
//   node rename-stored.cjs            dry run: prints old → new, and any problem
//   node rename-stored.cjs --yes      writes ONE commit to the reports repo (files moved by reference, nothing re-uploaded;
//                                     manifest entries keep their size, date and price). `git revert` of that commit undoes it.
// A name that is already in the new scheme is left alone. Nothing is renamed if two reports would get the same name.
const { execFileSync } = require("child_process");
const { REPO } = require("./lib.cjs");
const N = require("./naming.cjs");

const yes = process.argv.includes("--yes");
const gh = (args, input) => execFileSync("gh", args, { input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] }).toString();
const api = (p, extra = []) => JSON.parse(gh(["api", `repos/${REPO}/${p}`, ...extra]));
const raw = (p) => gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${p}`]);

const NEW = /^(AQ|Climt|Sust)-(Full|Snap|Bench)-/;
const manifest = JSON.parse(raw("manifest.json"));
const framework = (html) => ((/<meta name="emerald-framework" content="([a-z-]+)"/.exec(html.slice(0, 20000)) || [])[1]) || "air-quality";

const plan = []; const problems = [];
for (const r of manifest.reports) {
  if (NEW.test(r.name)) continue;
  try {
    let neu;
    const d = /^aq-(snapshot|benchmark)-(.+)-(\d{4}-\d\d-\d\d)-to-(\d{4}-\d\d-\d\d)\.html$/.exec(r.name);
    if (d) {
      const html = raw(`reports/${r.name}`);
      neu = N.reportName({ subject: N.subjectOfFramework(framework(html)), kind: d[1], dateFrom: d[3], dateTo: d[4], org: d[2] });
    } else if (/^TMP-.*orgs\.html$/.test(r.name)) {
      const t = JSON.parse(raw(`reports/${r.name.replace(/\.html$/, ".json")}`));
      const fw = framework(raw(`reports/${r.name}`));
      neu = N.reportName({ subject: N.subjectOfFramework(fw), kind: "Full", dateFrom: t.dateFrom, dateTo: t.dateTo, orgs: t.orgs.length });
    } else { problems.push(`${r.name}: not a name this tool knows`); continue; }
    plan.push({ entry: r, old: r.name, neu });
  } catch (e) { problems.push(`${r.name}: ${String(e.message).split("\n")[0]}`); }
}

const taken = new Map();
for (const r of manifest.reports) if (NEW.test(r.name)) taken.set(r.name, r.name);
for (const p of plan) {
  if (taken.has(p.neu)) problems.push(`${p.old} and ${taken.get(p.neu)} would both be ${p.neu}`);
  taken.set(p.neu, p.old);
}

for (const p of plan) console.log(`${p.old}\n   → ${p.neu}`);
console.log(`\n${plan.length} to rename, ${manifest.reports.length - plan.length} already in the new scheme or skipped`);
if (problems.length) { console.error("\nNOT RENAMED — fix these first:\n- " + problems.join("\n- ")); process.exit(1); }
if (!yes) { console.log("\nDry run. Add --yes to write one commit."); process.exit(0); }

// ── one commit: new paths point at the old blobs, old paths are removed, manifest rewritten ──
const head = api("git/ref/heads/main").object.sha;
const commit = api(`git/commits/${head}`);
const tree = api(`git/trees/${commit.tree.sha}?recursive=1`);
if (tree.truncated) { console.error("the repo tree is too large to rewrite in one commit"); process.exit(1); }
const blob = new Map(tree.tree.map((t) => [t.path, t]));
const entries = [];
const move = (from, to) => { const t = blob.get(from); if (!t) return false; entries.push({ path: to, mode: t.mode, type: "blob", sha: t.sha }, { path: from, mode: t.mode, type: "blob", sha: null }); return true; };
for (const p of plan) {
  if (!move(`reports/${p.old}`, `reports/${p.neu}`)) { console.error(`missing file reports/${p.old}`); process.exit(1); }
  move(`reports/${p.old.replace(/\.html$/, ".json")}`, `reports/${p.neu.replace(/\.html$/, ".json")}`); // trend data, when there is some
}
const byOld = new Map(plan.map((p) => [p.old, p.neu]));
const newManifest = { reports: manifest.reports.map((r) => (byOld.has(r.name) ? { ...r, name: byOld.get(r.name) } : r)) };
const mb = JSON.parse(gh(["api", "-X", "POST", `repos/${REPO}/git/blobs`, "--input", "-"], JSON.stringify({ content: JSON.stringify(newManifest, null, 2), encoding: "utf-8" })));
entries.push({ path: "manifest.json", mode: "100644", type: "blob", sha: mb.sha });
const nt = JSON.parse(gh(["api", "-X", "POST", `repos/${REPO}/git/trees`, "--input", "-"], JSON.stringify({ base_tree: commit.tree.sha, tree: entries })));
const nc = JSON.parse(gh(["api", "-X", "POST", `repos/${REPO}/git/commits`, "--input", "-"], JSON.stringify({ message: `Rename ${plan.length} reports to the <Subject>-<Kind>-<period>-<n>orgs scheme`, tree: nt.sha, parents: [head] })));
gh(["api", "-X", "PATCH", `repos/${REPO}/git/refs/heads/main`, "--input", "-"], JSON.stringify({ sha: nc.sha, force: false }));
console.log(`\nRENAMED ${plan.length} reports in one commit ${nc.sha.slice(0, 10)} (revert that commit to undo).`);
