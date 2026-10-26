#!/usr/bin/env node
// Step 1 — get the data the app collected.
//   node fetch.cjs list                      saved collections in the reports repo (raw/)
//   node fetch.cjs get <name> [--out dir]    download one to dir (default ./work)
// Uses the GitHub CLI (`gh`) that is already signed in; nothing is written to the reports repo.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REPO, arg, positional } = require("./lib.cjs");

const gh = (args, opts = {}) => execFileSync("gh", args, { maxBuffer: 1 << 29, ...opts });
const [cmd, name] = positional();

if (cmd === "list") {
  const rows = JSON.parse(gh(["api", `repos/${REPO}/contents/raw`]).toString());
  for (const r of rows) console.log(`${r.name}  ${(r.size / 1024).toFixed(0)} KB`);
} else if (cmd === "get" && name) {
  const out = path.resolve(arg("out", "work"));
  fs.mkdirSync(out, { recursive: true });
  const buf = gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/raw/${name}`]);
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`saved ${path.join(out, name)} (${(buf.length / 1024).toFixed(0)} KB)`);
} else {
  console.error("usage: node fetch.cjs list | node fetch.cjs get <name> [--out dir]");
  process.exit(1);
}
