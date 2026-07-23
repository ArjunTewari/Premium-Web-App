'use strict';
/**
 * test-sentinel-graph.js — characterization tests proving the LangGraph
 * port (graphs/social-sentinel-graph.js) behaves identically to the legacy
 * hand-rolled implementation (sentinel.js's socialSentinelLegacy) across
 * every branch: all-healthy, quota-exhaustion, retryable-succeeds,
 * retryable-fails-again, and a mixed scenario.
 *
 * Run: node test-sentinel-graph.js
 */

const assert = require('assert');
const Sentinel = require('./sentinel');
const { run: graphRun } = require('./graphs/social-sentinel-graph');
const APIdirect = require('./apidirect-collector');

// Both sentinel.js (`./apidirect-collector`) and the graph module
// (`../apidirect-collector`) resolve to this SAME cached module object, so
// monkey-patching these functions here is visible to both implementations.
const originalFetchers = {
  fetchLinkedIn: APIdirect.fetchLinkedIn,
  fetchTwitter: APIdirect.fetchTwitter,
  fetchInstagram: APIdirect.fetchInstagram,
};

function mockFetchers({ li, tw, ig } = {}) {
  const calls = [];
  APIdirect.fetchLinkedIn = async (org, handle, key, dateRange, aqKw, cb) => {
    calls.push({ platform: 'li', org });
    return li ? li(org) : { failed: false, postCount: 0 };
  };
  APIdirect.fetchTwitter = async (org, handle, key, dateRange, aqKw, cb) => {
    calls.push({ platform: 'tw', org });
    return tw ? tw(org) : { failed: false, postCount: 0 };
  };
  APIdirect.fetchInstagram = async (org, handle, key, dateRange, aqKw, cb) => {
    calls.push({ platform: 'ig', org });
    return ig ? ig(org) : { failed: false, postCount: 0 };
  };
  return calls;
}

function restoreFetchers() {
  Object.assign(APIdirect, originalFetchers);
}

const cfg = { SCOPE_KEYWORDS: [], DATE_FROM: '2026-01-01', DATE_TO: '2026-02-01', APIDIRECT_KEY: 'test-key' };

async function runBoth(fixture, orgHandles) {
  const legacyInput = structuredClone(fixture);
  const graphInput = structuredClone(fixture);
  const legacyLogs = [];
  const graphLogs = [];
  const legacyResult = await Sentinel.socialSentinelLegacy(legacyInput, { cfg, orgHandles, cb: (m, l) => legacyLogs.push({ m: m.trim(), l }) });
  const graphResult = await graphRun(graphInput, { cfg, orgHandles, cb: (m, l) => graphLogs.push({ m: m.trim(), l }) });
  return { legacyResult, graphResult, legacyLogs, graphLogs };
}

let passed = 0, failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS - ${label}`);
    passed++;
  } catch (e) {
    console.log(`FAIL - ${label}: ${e.message}`);
    failed++;
  }
}

(async () => {
  // ── Scenario 1: all-healthy ──────────────────────────────────────────────
  {
    restoreFetchers(); // no mocks needed — nothing should be called
    const fixture = [{
      org: 'HealthyOrg',
      li: { postCount: 2, fetched: 2, afterAuthor: 2, inRangeCount: 2 },
      tw: { postCount: 1, fetched: 1, afterAuthor: 1, inRangeCount: 1 },
      ig: { postCount: 0, noHandle: true },
    }];
    const { legacyResult, graphResult, legacyLogs, graphLogs } = await runBoth(fixture, {});
    check('Scenario 1 (all-healthy): outputs deep-equal', () => assert.deepStrictEqual(legacyResult, graphResult));
    check('Scenario 1: both log "all healthy"', () => {
      assert.ok(legacyLogs.some(l => l.m.includes('all org × platform fetches healthy')));
      assert.ok(graphLogs.some(l => l.m.includes('all org × platform fetches healthy')));
    });
  }

  // ── Scenario 2: quota-exhaustion (mock fetchers throw if called) ────────
  {
    let called = false;
    APIdirect.fetchLinkedIn = async () => { called = true; throw new Error('should not be called'); };
    APIdirect.fetchTwitter = async () => { called = true; throw new Error('should not be called'); };
    APIdirect.fetchInstagram = async () => { called = true; throw new Error('should not be called'); };
    const fixture = [
      { org: 'OrgA', li: { postCount: 0, failed: true, failReason: 'rate_limit', failMessage: 'quota' }, tw: { postCount: 5, fetched: 5, afterAuthor: 5, inRangeCount: 5 }, ig: { postCount: 0, noHandle: true } },
      { org: 'OrgB', li: { postCount: 0, failed: true, failReason: 'rate_limit', failMessage: 'quota' }, tw: { postCount: 0, noHandle: true }, ig: { postCount: 0, noHandle: true } },
    ];
    const orgHandles = { OrgA: { linkedin: '@a' }, OrgB: { linkedin: '@b' } };
    const { legacyResult, graphResult, legacyLogs, graphLogs } = await runBoth(fixture, orgHandles);
    check('Scenario 2 (quota-exhaustion): mock fetchers never invoked', () => assert.strictEqual(called, false));
    check('Scenario 2: outputs deep-equal (unchanged, no repair)', () => assert.deepStrictEqual(legacyResult, graphResult));
    check('Scenario 2: both log quota-exhausted verdict at err level', () => {
      assert.ok(legacyLogs.some(l => l.l === 'err' && l.m.includes('quota exhausted')));
      assert.ok(graphLogs.some(l => l.l === 'err' && l.m.includes('quota exhausted')));
    });
  }

  // ── Scenario 3: retryable-succeeds ───────────────────────────────────────
  {
    mockFetchers({ li: () => ({ failed: false, postCount: 4, totalLikes: 10, fetched: 4, afterAuthor: 4, inRangeCount: 4 }) });
    const fixture = [{
      org: 'RetrySuccess',
      li: { postCount: 0, failed: true, failReason: 'timeout', failMessage: 'timed out' },
      tw: { postCount: 0, noHandle: true },
      ig: { postCount: 0, noHandle: true },
    }];
    const orgHandles = { RetrySuccess: { linkedin: '@retry' } };
    const { legacyResult, graphResult, legacyLogs, graphLogs } = await runBoth(fixture, orgHandles);
    check('Scenario 3 (retryable-succeeds): outputs deep-equal', () => assert.deepStrictEqual(legacyResult, graphResult));
    check('Scenario 3: entry patched in place with postCount=4', () => {
      assert.strictEqual(legacyResult[0].li.postCount, 4);
      assert.strictEqual(graphResult[0].li.postCount, 4);
    });
    check('Scenario 3: both log "1 repaired, 0 still unavailable"', () => {
      assert.ok(legacyLogs.some(l => l.m.includes('1 repaired, 0 still unavailable')));
      assert.ok(graphLogs.some(l => l.m.includes('1 repaired, 0 still unavailable')));
    });
  }

  // ── Scenario 4: retryable-fails-again ────────────────────────────────────
  {
    mockFetchers({ li: () => ({ failed: true, failReason: 'network', failMessage: 'still down', postCount: 0 }) });
    const fixture = [{
      org: 'RetryFail',
      li: { postCount: 0, failed: true, failReason: 'network', failMessage: 'down' },
      tw: { postCount: 0, noHandle: true },
      ig: { postCount: 0, noHandle: true },
    }];
    const orgHandles = { RetryFail: { linkedin: '@fail' } };
    const { legacyResult, graphResult, legacyLogs, graphLogs } = await runBoth(fixture, orgHandles);
    check('Scenario 4 (retryable-fails-again): outputs deep-equal', () => assert.deepStrictEqual(legacyResult, graphResult));
    check('Scenario 4: entry still marked failed', () => {
      assert.strictEqual(legacyResult[0].li.failed, true);
      assert.strictEqual(graphResult[0].li.failed, true);
    });
    check('Scenario 4: both log "0 repaired, 1 still unavailable" at warn', () => {
      assert.ok(legacyLogs.some(l => l.l === 'warn' && l.m.includes('0 repaired, 1 still unavailable')));
      assert.ok(graphLogs.some(l => l.l === 'warn' && l.m.includes('0 repaired, 1 still unavailable')));
    });
  }

  // ── Scenario 5: mixed (auth-skip + retry-success + retry-fail + zero) ───
  {
    mockFetchers({
      li: (org) => org === 'MixSuccess' ? { failed: false, postCount: 2, fetched: 2, afterAuthor: 2, inRangeCount: 2 } : { failed: true, failReason: 'unknown', postCount: 0 },
    });
    const fixture = [
      { org: 'MixAuthSkip', li: { postCount: 0, failed: true, failReason: 'auth', failMessage: 'bad key' }, tw: { postCount: 0, noHandle: true }, ig: { postCount: 0, noHandle: true } },
      { org: 'MixSuccess', li: { postCount: 0, failed: true, failReason: 'timeout', failMessage: 'timed out' }, tw: { postCount: 0, noHandle: true }, ig: { postCount: 0, noHandle: true } },
      { org: 'MixFail', li: { postCount: 0, failed: true, failReason: 'unknown', failMessage: 'weird' }, tw: { postCount: 0, noHandle: true }, ig: { postCount: 0, noHandle: true } },
      { org: 'MixZero', li: { postCount: 0, fetched: 3, afterAuthor: 3, inRangeCount: 0 }, tw: { postCount: 0, noHandle: true }, ig: { postCount: 0, noHandle: true } },
    ];
    const orgHandles = { MixAuthSkip: { linkedin: '@x' }, MixSuccess: { linkedin: '@y' }, MixFail: { linkedin: '@z' } };
    const { legacyResult, graphResult, legacyLogs, graphLogs } = await runBoth(fixture, orgHandles);
    check('Scenario 5 (mixed): outputs deep-equal', () => assert.deepStrictEqual(legacyResult, graphResult));
    check('Scenario 5: MixAuthSkip left failed (not retryable)', () => {
      assert.strictEqual(legacyResult[0].li.failed, true);
      assert.strictEqual(graphResult[0].li.failed, true);
    });
    check('Scenario 5: MixSuccess repaired to postCount=2', () => {
      assert.strictEqual(legacyResult[1].li.postCount, 2);
      assert.strictEqual(graphResult[1].li.postCount, 2);
    });
    check('Scenario 5: MixFail still failed after retry', () => {
      assert.strictEqual(legacyResult[2].li.failed, true);
      assert.strictEqual(graphResult[2].li.failed, true);
    });
    check('Scenario 5: MixZero untouched (genuine zero, not a failure)', () => {
      assert.strictEqual(legacyResult[3].li.failed, undefined);
      assert.strictEqual(graphResult[3].li.failed, undefined);
    });
    check('Scenario 5: both log the zero-diagnosis for MixZero', () => {
      assert.ok(legacyLogs.some(l => l.m.includes('MixZero') && l.m.includes('date window')));
      assert.ok(graphLogs.some(l => l.m.includes('MixZero') && l.m.includes('date window')));
    });
    check('Scenario 5: both log the auth-skip warning', () => {
      assert.ok(legacyLogs.some(l => l.m.includes('not retryable')));
      assert.ok(graphLogs.some(l => l.m.includes('not retryable')));
    });
    check('Scenario 5: both log "1 repaired, 2 still unavailable" (MixAuthSkip never retried + MixFail retried-but-failed both count as unavailable)', () => {
      assert.ok(legacyLogs.some(l => l.m.includes('1 repaired, 2 still unavailable')));
      assert.ok(graphLogs.some(l => l.m.includes('1 repaired, 2 still unavailable')));
    });
  }

  restoreFetchers();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
