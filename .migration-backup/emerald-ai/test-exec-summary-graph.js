'use strict';
/**
 * test-exec-summary-graph.js — verifies the exec-summary auto-repair graph
 * (graphs/exec-summary-graph.js): converges with corrective feedback when
 * the fact-check finds a mismatch, and degrades gracefully (bounded, no
 * infinite loop) when it never converges within MAX_RETRIES.
 *
 * Run: node test-exec-summary-graph.js
 */

const assert = require('assert');
const ClaudeClient = require('./claude-client');
const Sentinel = require('./sentinel');
const { run: execSummaryRun, MAX_RETRIES } = require('./graphs/exec-summary-graph');

const originalCallClaude = ClaudeClient.callClaude;
function restoreCallClaude() { ClaudeClient.callClaude = originalCallClaude; }

// Reuses the exact "AEO score restated as mention count" scenario already
// used to design/verify Sentinel.validateExecSummary earlier this session.
const data = {
  'Centre for Science and Environment': { total: 10, dataPct: 40, authPct: 90, aeo: 18, social: 0 },
  'IIT Delhi': { total: 8, dataPct: 0, authPct: 80, aeo: 9, social: 0 },
};
const ORGS = Object.keys(data);
const orgSummary = ORGS.map((o) => `${o}: AEO score ${data[o].aeo}/100`).join('\n');
const cfg = { CLAUDE_KEY: 'test-key' };

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS - ${label}`); passed++; }
  catch (e) { console.log(`FAIL - ${label}: ${e.message}`); failed++; }
}

(async () => {
  // ── Scenario A: wrong-then-corrected ─────────────────────────────────────
  {
    const promptsSeen = [];
    let callCount = 0;
    ClaudeClient.callClaude = async (prompt) => {
      promptsSeen.push(prompt);
      callCount++;
      if (callCount === 1) {
        // First attempt: hallucinated wrong number for IIT Delhi (claims 42
        // AEO mentions when actual aeo score is 9 — a deliberate mismatch).
        return JSON.stringify([
          { headline: 'IIT Delhi Surges', detail: 'IIT Delhi accumulated 42 AEO mentions this period.', section_ref: '§AEO LLM Visibility' },
        ]);
      }
      // Corrective attempt: correct number.
      return JSON.stringify([
        { headline: 'IIT Delhi Surges', detail: 'IIT Delhi accumulated an AEO score of 9.', section_ref: '§AEO LLM Visibility' },
      ]);
    };

    const logs = [];
    const result = await execSummaryRun({ cfg, data, ORGS, DATE_FROM: '2026-01-01', DATE_TO: '2026-02-01', orgSummary, cb: (m, l) => logs.push({ m: m.trim(), l }) });

    check('Scenario A: converges within 2 calls (1 initial + 1 corrective)', () => assert.strictEqual(callCount, 2));
    check('Scenario A: final execAudit has zero issues (converged)', () => assert.strictEqual(result.execAudit.issues.length, 0));
    check('Scenario A: corrective prompt contains the flagged mismatch details', () => {
      const correctivePrompt = promptsSeen[1];
      assert.ok(correctivePrompt.includes('42'), 'should include claimed value 42');
      assert.ok(correctivePrompt.includes('IIT Delhi'), 'should include org name');
      assert.ok(correctivePrompt.includes('9'), 'should include the actual correct value 9');
      assert.ok(/AEO/i.test(correctivePrompt), 'should include the metric label');
    });
    check('Scenario A: logs "verified ✓" at ok level on the successful pass', () => {
      assert.ok(logs.some((l) => l.l === 'ok' && l.m.includes('verified against computed data')));
    });
    check('Scenario A: logs a mismatch warning on the first (failed) pass', () => {
      assert.ok(logs.some((l) => l.l === 'warn' && l.m.includes("don't match computed data")));
    });
  }

  // ── Scenario B: LLM never converges on its own, but the deterministic
  //    final patch fixes it anyway (single unambiguous field: 'aeo') ───────
  {
    let callCount = 0;
    ClaudeClient.callClaude = async () => {
      callCount++;
      // Always the same wrong claim, regardless of corrective feedback —
      // Claude never gets it right within the retry budget.
      return JSON.stringify([
        { headline: 'CSE Dominates', detail: 'Centre for Science and Environment accumulated 99 AEO mentions.', section_ref: '§AEO LLM Visibility' },
      ]);
    };

    const logs = [];
    const result = await execSummaryRun({ cfg, data, ORGS, DATE_FROM: '2026-01-01', DATE_TO: '2026-02-01', orgSummary, cb: (m, l) => logs.push({ m: m.trim(), l }) });

    check(`Scenario B: bounded at exactly ${MAX_RETRIES + 1} total calls (1 initial + ${MAX_RETRIES} corrective)`, () => assert.strictEqual(callCount, MAX_RETRIES + 1));
    check('Scenario B: final execAudit is clean — the deterministic patch fixed it after the LLM loop gave up', () => assert.strictEqual(result.execAudit.issues.length, 0));
    check('Scenario B: finding text has the correct value (18) spliced in, not the hallucinated 99', () => {
      assert.ok(result.execF[0].detail.includes('18'), `expected corrected "18" in: ${result.execF[0].detail}`);
      assert.ok(!/\b99\b/.test(result.execF[0].detail), `hallucinated "99" should be gone: ${result.execF[0].detail}`);
    });
    check('Scenario B: warning logged on every LLM attempt (transparent transcript)', () => {
      const warnCount = logs.filter((l) => l.l === 'warn' && l.m.includes("don't match computed data")).length;
      assert.strictEqual(warnCount, MAX_RETRIES + 1);
    });
    check('Scenario B: logs the auto-correction as a distinct final step', () => {
      assert.ok(logs.some((l) => l.l === 'ok' && l.m.includes('auto-corrected 1 numeric claim')));
    });
  }

  // ── Scenario B2: ambiguous field ("%" maps to dataPct OR authPct) can't
  //    be auto-corrected — must stay flagged, not silently guessed ────────
  {
    ClaudeClient.callClaude = async () => JSON.stringify([
      { headline: 'IIT Delhi Data Focus', detail: 'IIT Delhi published 55% data-specific coverage.', section_ref: '§03 AQ Press Analytics' },
    ]);
    const logs = [];
    const result = await execSummaryRun({ cfg, data, ORGS, DATE_FROM: '2026-01-01', DATE_TO: '2026-02-01', orgSummary, cb: (m, l) => logs.push({ m: m.trim(), l }) });
    check('Scenario B2: ambiguous % mismatch remains flagged after the loop gives up (not auto-corrected)', () => {
      assert.strictEqual(result.execAudit.issues.length, 1);
      assert.strictEqual(result.execAudit.issues[0].correctedValue, null);
    });
    check('Scenario B2: finding text is untouched (no guessed splice)', () => {
      assert.ok(result.execF[0].detail.includes('55%'));
    });
  }

  // ── Scenario B3: regex-overlap fix — "0/100 AEO" must produce exactly
  //    ONE issue, not two contradictory ones from colliding patterns ──────
  {
    const execF = [{ headline: 'CSTEP Lags', detail: 'Centre for Science and Environment scored 0/100 AEO this period.', section_ref: '§AEO LLM Visibility' }];
    const audit = Sentinel.validateExecSummary(execF, data, ORGS);
    check('Scenario B3: exactly one issue for "0/100 AEO" (no double-count from overlapping patterns)', () => {
      assert.strictEqual(audit.issues.length, 1);
    });
    check('Scenario B3: the single issue carries the right claimed/actual values', () => {
      assert.strictEqual(audit.issues[0].claimed, 0);
      assert.strictEqual(audit.issues[0].actual, 'aeo=18');
    });
    check('Scenario B3: applyCorrections splices "0" -> "18", leaving "/100 AEO" intact', () => {
      const corrected = Sentinel.applyCorrections(execF, audit.issues);
      assert.strictEqual(corrected[0].detail, 'Centre for Science and Environment scored 18/100 AEO this period.');
    });
  }

  // ── Scenario C: correct on the very first attempt — no retry at all ─────
  {
    let callCount = 0;
    ClaudeClient.callClaude = async () => {
      callCount++;
      return JSON.stringify([
        { headline: 'IIT Delhi Steady', detail: 'IIT Delhi holds an AEO score of 9.', section_ref: '§AEO LLM Visibility' },
      ]);
    };
    const logs = [];
    const result = await execSummaryRun({ cfg, data, ORGS, DATE_FROM: '2026-01-01', DATE_TO: '2026-02-01', orgSummary, cb: (m, l) => logs.push({ m: m.trim(), l }) });
    check('Scenario C: exactly 1 call when correct on first try (no wasted retries)', () => assert.strictEqual(callCount, 1));
    check('Scenario C: execAudit clean', () => assert.strictEqual(result.execAudit.issues.length, 0));
  }

  restoreCallClaude();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
