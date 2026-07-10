'use strict';
/**
 * social-sentinel-graph.js — LangGraph.js port of sentinel.js's
 * socialSentinelLegacy(). Faithful behavioral port, not a redesign: every
 * node below maps 1:1 to a numbered step in the original function. See
 * sentinel.js's module doc for the validate→diagnose→repair→re-validate
 * shape this formalizes.
 *
 * cfg/orgHandles/cb are threaded via config.configurable, NOT graph state —
 * cb keeps its exact synchronous 2-arg call signature; nothing outside
 * emerald-ai/ reads LangGraph's own streaming API.
 *
 * No checkpointer: this graph runs start-to-finish inside one continuous
 * run(), no interrupt(), no cross-process resume (confirmed unnecessary via
 * spike test — StateGraph.compile() with no checkpointer works for a plain
 * self-looping invoke()).
 */

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const { validateSocial } = require('../sentinel');
const APIdirect = require('../apidirect-collector');

const overwrite = () => Annotation({ reducer: (_a, b) => b, default: () => undefined });

const State = Annotation.Root({
  rawResults: overwrite(),
  orgHandles: overwrite(),
  anomalies: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  failures: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  diagnosedZeros: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  rateLimited: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  quotaExhausted: Annotation({ reducer: (_a, b) => b, default: () => false }),
  retryQueue: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  retryIndex: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
  repairedCount: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
  aqKw: overwrite(),
  dateRange: overwrite(),
});

// 1. validate — sentinel.js:109-119 (validateSocial call, split, healthy log,
//    header log, per-zero diagnosis logs).
async function validate(state, config) {
  const { cb } = config.configurable;
  const anomalies = validateSocial(state.rawResults);
  if (!anomalies.length) {
    cb?.('  SENTINEL · social: all org × platform fetches healthy', 'ok');
    return { anomalies };
  }
  const failures = anomalies.filter((a) => a.type === 'fetch_failed');
  const diagnosedZeros = anomalies.filter((a) => a.type === 'zero_diagnosed');
  cb?.(`\n  SENTINEL · social: ${failures.length} failed fetch(es), ${diagnosedZeros.length} zero(es) diagnosed`, 'head');
  for (const a of diagnosedZeros) cb?.(`    ${a.org} · ${a.platformName}: ${a.diagnosis}`, 'warn');
  return { anomalies, failures, diagnosedZeros };
}

// Router after validate — sentinel.js:110-113 (no anomalies) and :121 (zeros-only).
function routeAfterValidate(state) {
  if (!state.anomalies.length) return END;
  if (!state.failures.length) return END;
  return 'checkQuota';
}

// 2. checkQuota — sentinel.js:123-129.
async function checkQuota(state, config) {
  const { cb } = config.configurable;
  const rateLimited = state.failures.filter((a) => a.reason === 'rate_limit');
  const quotaExhausted = rateLimited.length >= Math.max(2, state.failures.length / 2);
  if (quotaExhausted) {
    cb?.(`    VERDICT: API quota exhausted (${rateLimited.length}/${state.failures.length} rate-limit errors) — affected cells will render as unavailable, NOT zero. No retries (would burn remaining quota).`, 'err');
  }
  return { rateLimited, quotaExhausted };
}

function routeAfterQuota(state) {
  return state.quotaExhausted ? END : 'prepareRetries';
}

// 3. prepareRetries — sentinel.js:132-141. aqKw/dateRange built ONCE here,
//    not recomputed inside the retry loop — matches original exactly.
async function prepareRetries(state, config) {
  const { cb, cfg } = config.configurable;
  const retryable = state.failures.filter((a) => a.retryable);
  const skipped = state.failures.length - retryable.length;
  if (skipped > 0) cb?.(`    ${skipped} failure(s) not retryable (auth/rate-limit) — left as unavailable`, 'warn');
  if (!retryable.length) return { retryQueue: [] };

  cb?.(`    Repairing: retrying ${retryable.length} transient failure(s) sequentially…`);
  const aqKw = APIdirect.buildAqKeywords(cfg.SCOPE_KEYWORDS);
  const dateRange = { from: APIdirect.parseDate(cfg.DATE_FROM), to: APIdirect.parseDate(cfg.DATE_TO) };
  return { retryQueue: retryable.slice(0, 8), retryIndex: 0, repairedCount: 0, aqKw, dateRange };
}

function routeAfterPrepare(state) {
  return state.retryQueue.length === 0 ? END : 'retryOne';
}

// 4. retryOne — sentinel.js:143-161, one queue entry per invocation via a
//    self-loop edge (preserves the original's sequential 1200ms-spaced
//    retries — deliberately NOT a Send-based parallel fan-out, since this
//    layer only runs after apiFetch's own adaptive concurrency gate has
//    already signaled distress; fanning out in parallel here would
//    reintroduce the burst pressure the quota-exhaustion check exists to
//    avoid). Mutates rawResults entries in place, same as the original.
const handleKeyFor = { li: 'linkedin', tw: 'twitter', ig: 'instagram' };

async function retryOne(state, config) {
  const { cb, cfg, orgHandles } = config.configurable;
  // Looked up fresh at call time (not module load time) — matches
  // sentinel.js's original, and correctly picks up any reassignment of
  // apidirect-collector's exports (e.g. test mocks).
  const fetcherFor = { li: APIdirect.fetchLinkedIn, tw: APIdirect.fetchTwitter, ig: APIdirect.fetchInstagram };
  const a = state.retryQueue[state.retryIndex];
  const entry = state.rawResults.find((r) => r.org === a.org);
  const handle = (orgHandles[a.org] || {})[handleKeyFor[a.platform]] || null;

  if (!entry || !handle) {
    return { retryIndex: state.retryIndex + 1 };
  }

  await new Promise((res) => setTimeout(res, 1200));
  try {
    const fresh = await fetcherFor[a.platform](a.org, handle, cfg.APIDIRECT_KEY, state.dateRange, state.aqKw, cb);
    if (!fresh.failed) {
      entry[a.platform] = fresh;
      cb?.(`    ✓ ${a.org} · ${a.platformName}: retry succeeded (${fresh.postCount} posts)`, 'ok');
      return { retryIndex: state.retryIndex + 1, repairedCount: state.repairedCount + 1 };
    }
    cb?.(`    ✗ ${a.org} · ${a.platformName}: retry failed again (${fresh.failReason})`, 'warn');
    return { retryIndex: state.retryIndex + 1 };
  } catch (e) {
    cb?.(`    ✗ ${a.org} · ${a.platformName}: retry threw (${e.message})`, 'warn');
    return { retryIndex: state.retryIndex + 1 };
  }
}

// Loop bound enforced explicitly by this condition (retryQueue capped to 8
// entries by prepareRetries) — recursionLimit at invoke() is defense-in-depth
// only, not the real guard.
function routeAfterRetry(state) {
  return state.retryIndex < state.retryQueue.length ? 'retryOne' : 'finalVerdict';
}

// 5. finalVerdict — sentinel.js:164-165.
async function finalVerdict(state, config) {
  const { cb } = config.configurable;
  const remaining = validateSocial(state.rawResults).filter((a) => a.type === 'fetch_failed');
  cb?.(`    VERDICT: ${state.repairedCount} repaired, ${remaining.length} still unavailable — unavailable cells render as ✕, not 0`, remaining.length ? 'warn' : 'ok');
  return {};
}

const graph = new StateGraph(State)
  .addNode('validate', validate)
  .addNode('checkQuota', checkQuota)
  .addNode('prepareRetries', prepareRetries)
  .addNode('retryOne', retryOne)
  .addNode('finalVerdict', finalVerdict)
  .addEdge(START, 'validate')
  .addConditionalEdges('validate', routeAfterValidate)
  .addConditionalEdges('checkQuota', routeAfterQuota)
  .addConditionalEdges('prepareRetries', routeAfterPrepare)
  .addConditionalEdges('retryOne', routeAfterRetry)
  .addEdge('finalVerdict', END)
  .compile();

/**
 * Same signature/return shape as sentinel.js's socialSentinel(): returns
 * rawResults with retried entries patched in place.
 */
async function run(rawResults, { cfg, orgHandles, cb }) {
  const finalState = await graph.invoke(
    { rawResults, orgHandles },
    { configurable: { cfg, orgHandles, cb }, recursionLimit: 30 },
  );
  return finalState.rawResults;
}

module.exports = { run, graph };
