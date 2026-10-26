// Shared helpers for the Claude Code report workflow (see README.md in this folder).
const path = require("path");
const fs = require("fs");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..", "..");
const PIPE = path.join(ROOT, "artifacts", "api-server", "src", "pipeline");
const REPO = process.env.REPORTS_REPO || "ArjunTewari/emerald-ai-reports";

// The pipeline needs the app's dependencies (axios, etc.). Use the repo's own install, or PWA_NODE_MODULES.
function useAppModules() {
  const dirs = [process.env.PWA_NODE_MODULES, path.join(ROOT, "artifacts", "api-server", "node_modules"), path.join(ROOT, "node_modules")]
    .filter(Boolean).filter((d) => fs.existsSync(d));
  if (!dirs.length) {
    console.error("The app's dependencies are not installed. Run `pnpm install` in the repo root, or set PWA_NODE_MODULES to an existing node_modules folder.");
    process.exit(2);
  }
  process.env.NODE_PATH = [...dirs, process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

// The pipeline's Claude calls (executive summary, actions) are answered by `answer(prompt)`, which is supplied by
// the caller: Claude Code writes the text itself instead of the app calling the Claude CLI.
function stubClaude(answer) {
  const stub = {
    askClaude: async (p) => answer(String(p)),
    usage: {}, ClaudeCliError: Error, resolveCli: () => ({}), childEnv: () => ({}),
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return /(^|[\\/])claude-cli(\.js)?$/.test(request) ? stub : orig.call(this, request, ...rest);
  };
}

const pipe = (f) => require(path.join(PIPE, f));

function configFromCheckpoint(chk, extra = {}) {
  const fp = chk.fingerprint;
  return {
    ORGS: fp.orgs, DATE_FROM: fp.dateFrom, DATE_TO: fp.dateTo, CLIENT_NAME: "Weekly",
    SCOPE_KEYWORDS: fp.scopeKeywords, AEO_QUERIES: fp.aeoQueries, FRAMEWORK: fp.framework,
    CLAUDE_KEY: "claude-cli", resumeCheckpoint: chk, ...extra,
  };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
const positional = () => process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));

module.exports = { ROOT, PIPE, REPO, useAppModules, stubClaude, pipe, configFromCheckpoint, arg, positional };
