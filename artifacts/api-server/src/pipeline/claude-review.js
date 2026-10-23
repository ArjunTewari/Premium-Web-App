"use strict";
/**
 * claude-review.js — an independent reviewer for every report, run through the
 * Claude Code CLI (claude-cli.js), never the Anthropic API.
 *
 * It is given an evidence pack (the report's figures and post excerpts) and asked
 * to find figures that contradict each other, posts counted twice or not about the
 * subject, implausible values, and statements the figures do not support. The CLI
 * runs with tools switched off, so it can only read the prompt.
 *
 * Independence: the review is a separate call with its own instructions and the
 * strongest model alias (AUDIT_CLAUDE_MODEL, default "opus"), not the model that
 * wrote the summary. The rule checks in audit.js do not depend on any model.
 */

const { askClaude } = require("./claude-cli");

const MODEL = process.env.AUDIT_CLAUDE_MODEL || "opus";
const TIMEOUT_MS = Math.max(60000, parseInt(process.env.AUDIT_CLAUDE_TIMEOUT_MS || "420000", 10) || 420000);
const ATTEMPTS = 2;

const SYSTEM = "You are a meticulous auditor. You work only from the evidence given in the user message and reply with only the JSON object requested.";

const INSTRUCTIONS = `You are the independent auditor of a media-intelligence report. The report measures how visible each organisation is on the subject "{SUBJECT}" in press, in AI assistants and on social media, for the period {FROM} to {TO}. A person will rely on these figures. Your job is to stop a wrong figure from being published.

You have ONE source: the evidence pack below. You cannot fetch anything.

Look for, and report only what you can point to in the pack:
1. The same post counted more than once (identical or near-identical text/URL/metrics across posts, or totals that look like one set of posts repeated).
2. A counted post that is not about the subject (its text shows none of the subject's themes) or is misattributed to the wrong organisation.
3. Figures that contradict each other: counts versus listed posts, totals smaller than their parts, shares that do not follow from the figures, an organisation ranked or described in a way its figures do not support.
4. Implausible values for the period or the audience (for example a very high post count against a small account, engagement that does not match followers).
5. Any statement in the executive summary that the figures do not support, or that names the wrong organisation for a figure.
6. Data presented as a real zero although it was not collected. A platform marked collected:false is shown in the report as unavailable (a cross), never as a measured zero — do NOT report that as an error. Report it (as a warning) only if you see it described or scored as a measured absence of activity in the summary.

Rules:
- severity "error" = a figure or statement is wrong or unsupported, and you can show it from the pack. severity "warning" = suspicious but not provable from the pack.
- Do not comment on style, wording, formatting or choice of method. Do not invent problems. If the pack is consistent, return verdict "pass" and an empty findings list.
- "evidence" must quote the specific values from the pack. "where" names the section (for example "X posts", "executive summary").
- verdict is "fail" if there is at least one error finding, otherwise "pass".

Reply with ONLY a JSON object of exactly this shape, no other text:
{"verdict":"pass"|"fail","findings":[{"severity":"error"|"warning","org":"...","where":"...","issue":"...","evidence":"..."}]}`;

class ReviewError extends Error {
  constructor(message) { super(message); this.name = "ReviewError"; }
}

function parseReview(text) {
  const raw = String(text || "").trim();
  // tolerate a code fence or a sentence around the object, but nothing else
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let j;
  try { j = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); } catch { throw new ReviewError("the reviewer returned a reply that is not valid JSON"); }
  if (!j || (j.verdict !== "pass" && j.verdict !== "fail") || !Array.isArray(j.findings)) throw new ReviewError("the reviewer returned a reply that does not follow the required format");
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
      const text = await askClaude(prompt, { model: MODEL, system: SYSTEM, timeoutMs: TIMEOUT_MS });
      return { ...parseReview(text), model: `claude-cli:${MODEL}` };
    } catch (e) {
      lastErr = e;
      if (e.auth) break; // retrying cannot fix a login problem
      cb?.(`  AUDIT · Claude review attempt ${attempt}/${ATTEMPTS} failed: ${e.message}`, "warn");
    }
  }
  throw lastErr;
}

module.exports = { review, parseReview, ReviewError, INSTRUCTIONS };
