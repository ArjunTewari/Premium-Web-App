"use strict";
/**
 * claude-cli.js — every Claude call in the pipeline goes through the Claude CLI
 * (`claude -p`), never the Anthropic API.
 *
 * Why: the API is billed per token from a separate credit balance; the CLI runs
 * on the Claude plan the account is logged in with. This module must therefore
 * never fall back to the API:
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child's
 *     environment, because the CLI would otherwise prefer them and bill the API;
 *   - there is no HTTP code here at all.
 *
 * Authentication on a server: run `claude setup-token` once on a machine that is
 * logged in, and set the token it prints as CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Which binary: CLAUDE_CLI_PATH, else the one installed with this app
 * (node_modules/.bin/claude), else `claude` on PATH.
 *
 * Tools are switched off and the system prompt is replaced, so the CLI behaves as
 * a plain text model — the same job the API call did.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const CONCURRENCY = Math.max(1, parseInt(process.env.CLAUDE_CLI_CONCURRENCY || "6", 10) || 6);
const TIMEOUT_MS = Math.max(10000, parseInt(process.env.CLAUDE_CLI_TIMEOUT_MS || "180000", 10) || 180000);
const RETRY_DELAYS_MS = [3000, 10000];

// Counts calls for the run's usage summary (there are no tokens to bill).
const usage = { calls: 0, failures: 0 };

const DEFAULT_SYSTEM = "You are a precise analyst. Follow the instructions in the user message exactly and reply with only what is asked for.";

// -> { cmd, prefix, shell }: a .js/.cjs path is run with node (no shell); a Windows
// .cmd shim needs a shell; anything else is executed directly.
//
// Order: CLAUDE_CLI_PATH, then the CLI installed with this app. The app depends on
// @anthropic-ai/claude-code and uses its cli-wrapper.cjs, which finds the right
// native binary itself — so it works even where install scripts are skipped. Last
// resort: `claude` on PATH.
function resolveCli() {
  let target = process.env.CLAUDE_CLI_PATH;
  if (!target) {
    for (const base of [process.cwd(), path.join(process.cwd(), "artifacts", "api-server"), path.resolve(__dirname, "..", ".."), __dirname]) {
      try {
        target = createRequire(path.join(base, "noop.js")).resolve("@anthropic-ai/claude-code/cli-wrapper.cjs");
        break;
      } catch { /* not installed under this base */ }
    }
  }
  if (!target && process.platform === "win32" && process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(p)) target = p;
  }
  if (!target) target = "claude";
  if (/\.(m|c)?js$/i.test(target)) return { cmd: process.execPath, prefix: [target], shell: false };
  return { cmd: target, prefix: [], shell: /\.(cmd|bat)$/i.test(target) };
}

// API model ids -> the CLI's aliases, so a retired dated id can never break a call.
function cliModel(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return undefined;
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return model;
}

function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_KEY;
  return env;
}

// ── a tiny counting semaphore so a run never has more than N CLI processes ──
let active = 0;
const waiting = [];
function acquire() {
  if (active < CONCURRENCY) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

class ClaudeCliError extends Error {
  constructor(message, { retryable = false, auth = false } = {}) {
    super(message);
    this.name = "ClaudeCliError";
    this.retryable = retryable;
    this.auth = auth;
  }
}

function classify(text, code) {
  const t = String(text || "");
  if (/not logged in|please run \/login|invalid api key|oauth token|oauth session|authenticat|unauthor|setup-token|credit balance/i.test(t)) {
    return new ClaudeCliError(`Claude CLI is not authenticated: ${t.trim().slice(0, 300) || `exit ${code}`}`, { auth: true });
  }
  if (/rate limit|usage limit|limit reached|too many|overloaded|529|429|try again/i.test(t)) {
    return new ClaudeCliError(`Claude CLI was rate limited: ${t.trim().slice(0, 300)}`, { retryable: true });
  }
  return new ClaudeCliError(`Claude CLI failed${code !== null && code !== undefined ? ` (exit ${code})` : ""}: ${t.trim().slice(0, 300) || "no output"}`, { retryable: true });
}

function runOnce(prompt, { model, system, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const cli = resolveCli();
    const args = [
      ...cli.prefix,
      "-p",
      "--output-format", "json",
      "--tools", "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--system-prompt", system || DEFAULT_SYSTEM,
    ];
    const alias = cliModel(model);
    if (alias) args.push("--model", alias);
    let child;
    try {
      child = spawn(cli.cmd, args, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"], shell: cli.shell });
    } catch (e) {
      return reject(new ClaudeCliError(`Could not start the Claude CLI (${e.message}). Install it with "npm i -g @anthropic-ai/claude-code" or set CLAUDE_CLI_PATH.`, { auth: true }));
    }
    let out = "", err = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new ClaudeCliError(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`, { retryable: true })); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, new ClaudeCliError(
      e.code === "ENOENT" ? `The Claude CLI was not found. Install it with "npm i -g @anthropic-ai/claude-code" or set CLAUDE_CLI_PATH.` : `Could not run the Claude CLI: ${e.message}`,
      { auth: true })));
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not JSON */ }
      if (parsed && typeof parsed === "object" && parsed.is_error !== true && typeof parsed.result === "string" && code === 0) return finish(resolve, parsed.result);
      const detail = (parsed && (parsed.result || parsed.error)) || err || out;
      finish(reject, classify(detail, code));
    });
    child.stdin.on("error", () => { /* process exited early; close handler reports it */ });
    child.stdin.end(prompt);
  });
}

/**
 * Ask Claude (via the CLI) and return the reply text.
 * opts: { model, system, timeoutMs }
 */
async function askClaude(prompt, opts = {}) {
  const o = { model: opts.model, system: opts.system, timeoutMs: opts.timeoutMs || TIMEOUT_MS };
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await runOnce(prompt, o);
        usage.calls++;
        return text;
      } catch (e) {
        if (!e.retryable || attempt >= RETRY_DELAYS_MS.length) { usage.failures++; throw e; }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  } finally {
    release();
  }
}

module.exports = { askClaude, ClaudeCliError, usage, resolveCli, childEnv };
