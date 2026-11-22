#!/usr/bin/env node
// Every social post of a saved collection's period, each put in ONE scope (air quality / climate / sustainability / other) by the
// Claude CLI, as the file the web app's Interactive tab reads.
//   node scopes.cjs <collection.json.gz> [--out dir] [--cache scope-cache.json] [--yes]
//   --out    where the file is written (default ./work/interactive)
//   --cache  labels already made (by post address) are reused, new ones added: a second run on the same posts costs nothing
//   --yes    also puts it in the reports repo: interactive/<name>.json and interactive/index.json (what the tab lists)
// The collection is one saved by a run (or merged / trimmed by merge-weeks.cjs / trim-period.cjs); its period decides which posts
// are taken. Nothing is fetched. The labels are made with the Claude CLI, never the API.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib.cjs");
const N = require("./naming.cjs");
L.useAppModules();

const file = L.positional()[0];
if (!file) { console.error("usage: node scopes.cjs <collection.json.gz> [--out dir] [--cache file] [--yes]"); process.exit(1); }
const yes = process.argv.includes("--yes");
const out = path.resolve(L.arg("out", path.join("work", "interactive")));
const cacheFile = L.arg("cache");
const gh = (args, input) => execFileSync("gh", args, { input, maxBuffer: 1 << 28, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });

const CP = L.pipe("checkpoint.js"), S = L.pipe("post-scopes.js"), { askClaude, usage } = L.pipe("claude-cli.js");

(async () => {
  const chk = CP.unpack(fs.readFileSync(file));
  const fp = chk.fingerprint;
  const posts = S.collectPosts(chk.state.socialERResults, fp.dateFrom, fp.dateTo);
  console.log(`${fp.dateFrom} to ${fp.dateTo}: ${posts.length} posts from ${new Set(posts.map((p) => p.org)).size} organisations`);
  const cache = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const before = Object.keys(cache).length;
  await S.labelPosts(posts, { askClaude, cache, log: (m) => console.log(m) });
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache));

  const name = N.interactiveName({ dateFrom: fp.dateFrom, dateTo: fp.dateTo, orgs: fp.orgs.length });
  const ds = S.buildDataset({ posts, from: fp.dateFrom, to: fp.dateTo, framework: "all", orgs: fp.orgs, reportName: name });
  fs.mkdirSync(out, { recursive: true });
  const body = JSON.stringify(ds);
  fs.writeFileSync(path.join(out, name), body);
  const counts = Object.fromEntries(ds.scopes.map((s) => [s.id, ds.posts.filter((p) => p.s === s.id).length]));
  console.log(`\n${name}: ${posts.length} posts · ${JSON.stringify(counts)} · ${ds.unlabelled} without a scope · ${(body.length / 1024).toFixed(0)} KB · Claude calls ${usage.calls}, failed ${usage.failures} (${Object.keys(cache).length - before} new labels)`);
  console.log(`written ${path.join(out, name)}`);

  if (!yes) { console.log("\nNot put in the web app. Add --yes to do that."); return; }
  if (ds.unlabelled) { console.error(`\nNOT PUT IN THE WEB APP: ${ds.unlabelled} posts have no scope (a Claude batch failed). Run again: the labels made so far are kept with --cache.`); process.exit(1); }
  const api = (p) => JSON.parse(gh(["api", `repos/${L.REPO}/${p}`]).toString());
  const sha = (p) => { try { return api(`contents/${p}`).sha; } catch { return null; } };
  const put = (p, content, message) => { const s = sha(p); gh(["api", "-X", "PUT", `repos/${L.REPO}/contents/${p}`, "--input", "-"], JSON.stringify({ message, content: Buffer.from(content).toString("base64"), branch: "main", ...(s ? { sha: s } : {}) })); };
  put(`interactive/${name}`, body, `Add interactive posts: ${name}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    let cur = [], s = null;
    try { const m = api("contents/interactive/index.json"); s = m.sha; cur = JSON.parse(Buffer.from(m.content, "base64").toString("utf8")).reports || []; } catch { /* first one */ }
    const next = [...cur.filter((x) => x.name !== name), { name, size: Math.round(body.length / 1024), mtime: new Date().toISOString().slice(0, 16), dateFrom: fp.dateFrom, dateTo: fp.dateTo, orgs: fp.orgs.length, posts: ds.posts.length, counts }];
    try { gh(["api", "-X", "PUT", `repos/${L.REPO}/contents/interactive/index.json`, "--input", "-"], JSON.stringify({ message: `Update interactive index: ${name}`, content: Buffer.from(JSON.stringify({ reports: next }, null, 2)).toString("base64"), branch: "main", ...(s ? { sha: s } : {}) })); break; }
    catch (e) { if (attempt === 2) throw e; }
  }
  console.log(`PUT IN THE WEB APP interactive/${name}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
