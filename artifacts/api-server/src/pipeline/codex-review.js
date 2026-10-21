"use strict";
/**
 * codex-review.js — an independent reviewer for every report, run through the
 * Codex CLI (`codex exec`).
 *
 * It is given an evidence pack (the report's figures and post excerpts) and asked
 * to find figures that contradict each other, posts counted twice or not about the
 * subject, implausible values, and statements the figures do not support. It has
 * no tools, no network use and no files: the sandbox is read-only and the prompt
 * contains everything it may use.
 *
 * Authentication on a server: set CODEX_API_KEY (falls back to OPENAI_KEY). On a
 * machine where Codex is signed in with ChatGPT, nothing needs to be set.
 *
 * Which binary: CODEX_CLI_PATH, else the one installed with this app
 * (@openai/codex), else `codex` on PATH.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const TIMEOUT_MS = Math.max(30000, parseInt(process.env.CODEX_REVIEW_TIMEOUT_MS || "420000", 10) || 420000);
const ATTEMPTS = 2;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "org", "where", "issue", "evidence"],
        properties: {
          severity: { type: "string", enum: ["error", "warning"] },
          org: { type: "string" },
          where: { type: "string" },
          issue: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const INSTRUCTIONS = `You are the independent auditor of a media-intelligence report. The report measures how visible each organisation is on the subject "{SUBJECT}" in press, in AI assistants and on social media, for the period {FROM} to {TO}. A person will rely on these figures. Your job is to stop a wrong figure from being published.

You have ONE source: the evidence pack below. You cannot fetch anything. Do not run commands.

Look for, and report only what you can point to in the pack:
1. The same post counted more than once (identical or near-identical text/URL/metrics across posts, or totals that look like one set of posts repeated).
2. A counted post that is not about the subject (its text shows none of the subject's themes) or is misattributed to the wrong organisation.
3. Figures that contradict each other: counts versus listed posts, totals smaller than their parts, shares that do not follow from the figures, an organisation ranked or described in a way its figures do not support.
4. Implausible values for the period or the audience (for example a very high post count against a small account, engagement that does not match followers).
5. Any statement in the executive summary that the figures do not support, or that names the wrong organisation for a figure.
6. Data that is missing or marked failed but is presented as a real zero.

Rules:
- severity "error" = a figure or statement is wrong or unsupported, and you can show it from the pack. severity "warning" = suspicious but not provable from the pack.
- Do not comment on style, wording, formatting or choice of method. Do not invent problems. If the pack is consistent, return verdict "pass" and an empty findings list.
- "evidence" must quote the specific values from the pack. "where" names the section (for example "X posts", "executive summary").
- verdict is "fail" if there is at least one error finding, otherwise "pass".

Reply with only the JSON object required by the schema.`;

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

function childEnv() {
  const env = { ...process.env };
  const key = process.env.CODEX_API_KEY || process.env.OPENAI_KEY;
  if (key) env.CODEX_API_KEY = key;
  return env;
}

class CodexError extends Error {
  constructor(message, { auth = false } = {}) { super(message); this.name = "CodexError"; this.auth = auth; }
}

function runCodex(prompt, { timeoutMs = TIMEOUT_MS, schema = true } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-"));
    const outFile = path.join(dir, "out.json");
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    const cli = resolveCli();
    const args = [...cli.prefix, "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--sandbox", "read-only", "--color", "never", "-C", dir, "-o", outFile];
    if (schema) {
      const schemaFile = path.join(dir, "schema.json");
      fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
      args.push("--output-schema", schemaFile);
    }
    if (process.env.CODEX_MODEL) args.push("-m", process.env.CODEX_MODEL);
    args.push("-");
    let child, err = "", out = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); cleanup(); fn(v); };
    try {
      child = spawn(cli.cmd, args, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"], shell: cli.shell, windowsHide: true });
    } catch (e) {
      cleanup();
      return reject(new CodexError(`Could not start the Codex CLI (${e.message}). Install it with "npm i -g @openai/codex" or set CODEX_CLI_PATH.`));
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new CodexError(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, new CodexError(e.code === "ENOENT" ? `The Codex CLI was not found. Install it with "npm i -g @openai/codex" or set CODEX_CLI_PATH.` : `Could not run the Codex CLI: ${e.message}`)));
    child.on("close", (code) => {
      let text = "";
      try { text = fs.readFileSync(outFile, "utf8"); } catch { /* no output file */ }
      if (code === 0 && text.trim()) {
        const model = (/^model:\s*(\S+)/im.exec(err + out) || [])[1];
        return finish(resolve, { text, model });
      }
      const detail = (err || out || "").trim();
      const auth = /not logged in|log in|login|unauthor|invalid api key|incorrect api key|401|403|api key/i.test(detail);
      finish(reject, new CodexError(`Codex CLI failed${code !== null ? ` (exit ${code})` : ""}: ${detail.slice(-300) || "no output"}`, { auth }));
    });
    child.stdin.on("error", () => { /* closed early; the close handler reports it */ });
    child.stdin.end(prompt);
  });
}

function parseReview(text) {
  let j;
  try { j = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new CodexError("Codex returned a reply that is not valid JSON"); }
  if (!j || (j.verdict !== "pass" && j.verdict !== "fail") || !Array.isArray(j.findings)) throw new CodexError("Codex returned a reply that does not follow the required format");
  const findings = j.findings
    .filter((f) => f && typeof f.issue === "string" && f.issue.trim())
    .map((f) => ({ severity: f.severity === "error" ? "error" : "warning", org: String(f.org || ""), where: String(f.where || ""), issue: f.issue.trim(), evidence: String(f.evidence || "").trim() }));
  return { verdict: j.verdict, findings };
}

/** Review an evidence pack. Resolves { verdict, findings, model }; rejects if the review could not be completed. */
async function review(pack, { cb } = {}) {
  const prompt = `${INSTRUCTIONS.replace("{SUBJECT}", pack.subject || "the report subject").replace("{FROM}", pack.reportPeriod?.from || "").replace("{TO}", pack.reportPeriod?.to || "")}\n\n<evidence_pack>\n${JSON.stringify(pack)}\n</evidence_pack>\n`;
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const { text, model } = await runCodex(prompt);
      return { ...parseReview(text), model };
    } catch (e) {
      lastErr = e;
      if (e.auth) break; // retrying cannot fix a login problem
      cb?.(`  AUDIT · Codex attempt ${attempt}/${ATTEMPTS} failed: ${e.message}`, "warn");
    }
  }
  throw lastErr;
}

/** Pre-run check: is the Codex CLI usable right now? Resolves the model name or rejects. */
async function ping() {
  const { text } = await runCodex('Reply with the single word OK.', { timeoutMs: 120000, schema: false });
  if (!/ok/i.test(text)) throw new CodexError(`Codex answered unexpectedly: ${text.slice(0, 80)}`);
  return true;
}

module.exports = { review, ping, parseReview, resolveCli, CodexError, SCHEMA };
