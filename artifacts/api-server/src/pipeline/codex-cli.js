"use strict";
/**
 * codex-cli.js — every ChatGPT call in the pipeline goes through the Codex CLI
 * (`codex exec`), signed in with a ChatGPT account — never the OpenAI API.
 *
 * Used for the AI-assistant visibility probe (which organisations ChatGPT names when
 * asked the AEO questions). This module must therefore never use an API key:
 *   - OPENAI_API_KEY / CODEX_API_KEY / OPENAI_KEY are removed from the child's
 *     environment, and the CLI is told to accept only a ChatGPT sign-in
 *     (forced_login_method = "chatgpt");
 *   - there is no HTTP code here at all.
 *
 * Authentication on a server: sign in once on a machine ("codex login"), then set the
 * contents of its ~/.codex/auth.json as CODEX_AUTH_JSON. It is written to a private
 * CODEX_HOME (CODEX_HOME if set — point it at a persistent volume so the refreshed tokens
 * survive redeploys — else a temp folder) the first time it is needed. Where Codex is already
 * signed in (a developer machine), nothing is needed.
 *
 * Which binary: CODEX_CLI_PATH, else the one installed with this app (@openai/codex),
 * else `codex` on PATH. The sandbox is read-only, nothing is persisted, and the prompt tells
 * the model to answer from its own knowledge.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const CONCURRENCY = Math.max(1, parseInt(process.env.CODEX_CONCURRENCY || "3", 10) || 3);
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.CODEX_TIMEOUT_MS || "240000", 10) || 240000);
const RETRY_DELAYS_MS = [4000, 12000];

const usage = { calls: 0, failures: 0 };

class CodexError extends Error {
  constructor(message, { retryable = false, auth = false } = {}) {
    super(message);
    this.name = "CodexError";
    this.retryable = retryable;
    this.auth = auth;
  }
}

// -> { cmd, prefix, shell }
function resolveCli() {
  let target = process.env.CODEX_CLI_PATH;
  if (!target) {
    for (const base of [process.cwd(), path.join(process.cwd(), "artifacts", "api-server"), path.resolve(__dirname, "..", ".."), __dirname]) {
      try {
        target = createRequire(path.join(base, "noop.js")).resolve("@openai/codex/bin/codex.js");
        break;
      } catch { /* not installed under this base */ }
    }
  }
  if (!target && process.platform === "win32" && process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(p)) target = p;
  }
  if (!target) target = "codex";
  if (/\.(m|c)?js$/i.test(target)) return { cmd: process.execPath, prefix: [target], shell: false };
  return { cmd: target, prefix: [], shell: process.platform === "win32" };
}

// The sign-in the CLI will use. With CODEX_AUTH_JSON set, it is placed in a private CODEX_HOME so a
// server needs no interactive login. Returns the CODEX_HOME to use, or undefined to leave the CLI's
// own default (~/.codex).
function prepareHome() {
  const raw = process.env.CODEX_AUTH_JSON;
  if (!raw) return process.env.CODEX_HOME || undefined;
  let j;
  try { j = JSON.parse(raw); } catch { throw new CodexError("CODEX_AUTH_JSON is not valid JSON — paste the whole contents of ~/.codex/auth.json", { auth: true }); }
  if (j.auth_mode !== "chatgpt" || j.OPENAI_API_KEY || !j.tokens) {
    throw new CodexError("CODEX_AUTH_JSON must be a ChatGPT sign-in (auth_mode \"chatgpt\"), not an API key", { auth: true });
  }
  const home = process.env.CODEX_HOME || path.join(os.tmpdir(), "emerald-codex-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "auth.json");
  // Keep an existing file: the CLI refreshes its tokens in place, and that copy is newer.
  if (!fs.existsSync(file)) fs.writeFileSync(file, raw, { mode: 0o600 });
  return home;
}

function childEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_KEY;
  delete env.CODEX_AUTH_JSON;
  const home = prepareHome();
  if (home) env.CODEX_HOME = home;
  return env;
}

// ── a tiny counting semaphore so a run never has more than N Codex processes ──
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

function classify(text, code) {
  const t = String(text || "");
  if (/not logged in|please log ?in|log in again|login|unauthor|invalid api key|incorrect api key|refresh token|401|403/i.test(t)) {
    return new CodexError(`Codex CLI is not signed in with ChatGPT: ${t.trim().slice(-300) || `exit ${code}`}`, { auth: true });
  }
  if (/rate limit|usage limit|limit reached|too many|429|try again/i.test(t)) {
    return new CodexError(`Codex CLI was rate limited: ${t.trim().slice(-300)}`, { retryable: true });
  }
  return new CodexError(`Codex CLI failed${code !== null && code !== undefined ? ` (exit ${code})` : ""}: ${t.trim().slice(-300) || "no output"}`, { retryable: true });
}

function runOnce(prompt, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-"));
    const outFile = path.join(dir, "out.txt");
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    let env;
    try { env = childEnv(); } catch (e) { cleanup(); return reject(e); }
    const cli = resolveCli();
    const args = [...cli.prefix, "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--sandbox", "read-only", "--color", "never", "-c", 'forced_login_method="chatgpt"', "-C", dir, "-o", outFile];
    if (process.env.CODEX_MODEL) args.push("-m", process.env.CODEX_MODEL);
    args.push("-");
    let child, out = "", err = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); cleanup(); fn(v); };
    try {
      child = spawn(cli.cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: cli.shell, windowsHide: true });
    } catch (e) {
      cleanup();
      return reject(new CodexError(`Could not start the Codex CLI (${e.message}). Install it with "npm i -g @openai/codex" or set CODEX_CLI_PATH.`, { auth: true }));
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new CodexError(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s`, { retryable: true })); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, new CodexError(
      e.code === "ENOENT" ? `The Codex CLI was not found. Install it with "npm i -g @openai/codex" or set CODEX_CLI_PATH.` : `Could not run the Codex CLI: ${e.message}`,
      { auth: true })));
    child.on("close", (code) => {
      let text = "";
      try { text = fs.readFileSync(outFile, "utf8"); } catch { /* no output file */ }
      if (code === 0 && text.trim()) return finish(resolve, text);
      finish(reject, classify(err || out, code));
    });
    child.stdin.on("error", () => { /* closed early; the close handler reports it */ });
    child.stdin.end(prompt);
  });
}

/** Ask ChatGPT (through the Codex CLI) and return the reply text. */
async function askChatGPT(prompt, opts = {}) {
  const o = { timeoutMs: opts.timeoutMs || TIMEOUT_MS };
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

/**
 * Ask several questions in ONE Codex call (each call is an agent turn of ~15-30 s, and a
 * ChatGPT plan has usage limits). Returns an array of answers, one per question, or throws if the
 * reply does not hold exactly one answer per question.
 */
async function askChatGPTBatch(questions) {
  const prompt = `Answer each question below from your own knowledge. Do not run commands, read files or browse.\nFor every question reply in 1-2 sentences listing only organisation names, no explanations.\nReturn ONLY a JSON array of ${questions.length} strings, one answer per question, in the same order. No other text.\n\n${questions.map((q, i) => `Q${i + 1}: ${q}`).join("\n")}`;
  const text = await askChatGPT(prompt);
  return parseAnswers(text, questions.length);
}

function parseAnswers(text, n) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("["), end = raw.lastIndexOf("]");
  let arr;
  try { arr = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); } catch { throw new CodexError("ChatGPT returned a reply that is not a JSON array", { retryable: true }); }
  if (!Array.isArray(arr) || arr.length !== n) throw new CodexError(`ChatGPT returned ${Array.isArray(arr) ? arr.length : "no"} answers for ${n} questions`, { retryable: true });
  return arr.map((a) => String(a ?? ""));
}

/** Pre-run check: is the Codex CLI signed in and usable right now? */
async function ping() {
  const text = await askChatGPT("Reply with the single word OK.", { timeoutMs: 120000 });
  if (!/ok/i.test(text)) throw new CodexError(`Codex answered unexpectedly: ${text.slice(0, 80)}`);
  return true;
}

module.exports = { askChatGPT, askChatGPTBatch, parseAnswers, ping, resolveCli, childEnv, CodexError, usage };
