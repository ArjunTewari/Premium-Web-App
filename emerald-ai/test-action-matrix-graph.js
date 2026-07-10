'use strict';
/**
 * test-action-matrix-graph.js — verifies the action-matrix fan-out graph
 * (graphs/action-matrix-graph.js): per-org retry on transient failure,
 * early-stop on non-retryable classification, and — the key regression
 * check given this graph deviates from RetryPolicy — that ONE org's
 * permanent failure never crashes generation for the other orgs.
 *
 * Run: node test-action-matrix-graph.js
 */

const assert = require('assert');
const ClaudeClient = require('./claude-client');
const { run: actionMatrixRun, MAX_ATTEMPTS } = require('./graphs/action-matrix-graph');

const originalCallClaude = ClaudeClient.callClaude;
function restoreCallClaude() { ClaudeClient.callClaude = originalCallClaude; }

function mockActionsFor(org) {
  return JSON.stringify([
    { org, priority: 'Leverage', area: 'Media', action: 'a1', rationale: 'r1' },
    { org, priority: 'Optimise', area: 'Topics', action: 'a2', rationale: 'r2' },
    { org, priority: 'Invest', area: 'AEO', action: 'a3', rationale: 'r3' },
    { org, priority: 'Fix Now', area: 'Social', action: 'a4', rationale: 'r4' },
  ]);
}

function orgFromPrompt(prompt) {
  const m = prompt.match(/for "([^"]+)"/);
  return m ? m[1] : null;
}

const cfg = { CLAUDE_KEY: 'test-key' };

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS - ${label}`); passed++; }
  catch (e) { console.log(`FAIL - ${label}: ${e.message}`); failed++; }
}

(async () => {
  // ── Scenario A: 2 of 5 orgs time out once, then succeed on retry ────────
  {
    const ORGS = ['OrgA', 'OrgB', 'SlowOrg1', 'SlowOrg2', 'OrgE'];
    const orgSummary = ORGS.map((o) => `${o}: data line`).join('\n');
    const attemptsByOrg = {};

    ClaudeClient.callClaude = async (prompt) => {
      const org = orgFromPrompt(prompt);
      attemptsByOrg[org] = (attemptsByOrg[org] || 0) + 1;
      if ((org === 'SlowOrg1' || org === 'SlowOrg2') && attemptsByOrg[org] === 1) {
        throw new Error('timeout'); // first attempt for these two: fails
      }
      return mockActionsFor(org);
    };

    const logs = [];
    const result = await actionMatrixRun({ cfg, ORGS, orgSummary, emerging: [], cb: (m, l) => logs.push({ m: m.trim(), l }) });

    check('Scenario A: all 5 orgs end up with actions (20 total, 4 each)', () => assert.strictEqual(result.actions.length, 20));
    check('Scenario A: every org represented in the final actions', () => {
      for (const org of ORGS) {
        assert.strictEqual(result.actions.filter((a) => a.org === org).length, 4, `${org} missing actions`);
      }
    });
    check('Scenario A: SlowOrg1/SlowOrg2 each took exactly 2 attempts', () => {
      assert.strictEqual(attemptsByOrg['SlowOrg1'], 2);
      assert.strictEqual(attemptsByOrg['SlowOrg2'], 2);
    });
    check('Scenario A: fast orgs took exactly 1 attempt each (no wasted retries)', () => {
      assert.strictEqual(attemptsByOrg['OrgA'], 1);
      assert.strictEqual(attemptsByOrg['OrgB'], 1);
      assert.strictEqual(attemptsByOrg['OrgE'], 1);
    });
    check('Scenario A: retry shows up in the log transcript', () => {
      assert.ok(logs.some((l) => l.m.includes('SlowOrg1') && l.m.includes('attempt 2')));
    });
  }

  // ── Scenario B: one org permanently fails (retryable classification) —
  //    must exhaust MAX_ATTEMPTS, degrade to 0 actions, and NOT crash the
  //    other orgs' generation. This is the core regression check for the
  //    hand-rolled-retry-instead-of-RetryPolicy design decision. ─────────
  {
    const ORGS = ['GoodOrg1', 'DeadOrg', 'GoodOrg2'];
    const orgSummary = ORGS.map((o) => `${o}: data line`).join('\n');
    const attemptsByOrg = {};

    ClaudeClient.callClaude = async (prompt) => {
      const org = orgFromPrompt(prompt);
      attemptsByOrg[org] = (attemptsByOrg[org] || 0) + 1;
      if (org === 'DeadOrg') throw new Error('temporary glitch'); // classifies as 'unknown', retryable, never succeeds
      return mockActionsFor(org);
    };

    const logs = [];
    let threw = false;
    let result;
    try {
      result = await actionMatrixRun({ cfg, ORGS, orgSummary, emerging: [], cb: (m, l) => logs.push({ m: m.trim(), l }) });
    } catch (e) {
      threw = true;
    }

    check('Scenario B: run() does not throw despite one org permanently failing', () => assert.strictEqual(threw, false));
    check(`Scenario B: DeadOrg exhausts exactly ${MAX_ATTEMPTS} attempts`, () => assert.strictEqual(attemptsByOrg['DeadOrg'], MAX_ATTEMPTS));
    check('Scenario B: DeadOrg contributes 0 actions', () => assert.strictEqual(result.actions.filter((a) => a.org === 'DeadOrg').length, 0));
    check('Scenario B: GoodOrg1/GoodOrg2 still get their actions (isolation proven)', () => {
      assert.strictEqual(result.actions.filter((a) => a.org === 'GoodOrg1').length, 4);
      assert.strictEqual(result.actions.filter((a) => a.org === 'GoodOrg2').length, 4);
    });
    check('Scenario B: "giving up" logged for DeadOrg', () => {
      assert.ok(logs.some((l) => l.m.includes('DeadOrg') && l.m.includes('giving up')));
    });
  }

  // ── Scenario C: non-retryable classification stops early (1 attempt) ───
  {
    const ORGS = ['AuthFailOrg'];
    const orgSummary = `${ORGS[0]}: data line`;
    let attempts = 0;
    ClaudeClient.callClaude = async () => {
      attempts++;
      throw new Error('invalid api key'); // classifies as 'auth', NOT in RETRYABLE
    };
    const result = await actionMatrixRun({ cfg, ORGS, orgSummary, emerging: [], cb: () => {} });
    check('Scenario C: non-retryable failure stops after exactly 1 attempt (no wasted retries)', () => assert.strictEqual(attempts, 1));
    check('Scenario C: 0 actions for the org', () => assert.strictEqual(result.actions.length, 0));
  }

  // ── Scenario D: gap topics threaded correctly into the prompt ──────────
  {
    const ORGS = ['GapOrg'];
    const orgSummary = `${ORGS[0]}: data line`;
    let seenPrompt = '';
    ClaudeClient.callClaude = async (prompt) => { seenPrompt = prompt; return mockActionsFor('GapOrg'); };
    await actionMatrixRun({ cfg, ORGS, orgSummary, emerging: [{ topic: 'Wildfire Smoke Tracking' }], cb: () => {} });
    check('Scenario D: gap topic appears in the generated prompt', () => assert.ok(seenPrompt.includes('Wildfire Smoke Tracking')));
  }

  restoreCallClaude();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
