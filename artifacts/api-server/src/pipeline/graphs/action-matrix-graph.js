'use strict';
/**
 * action-matrix-graph.js — LangGraph.js upgrade of pipeline.js's STEP 5b
 * per-org action-matrix loop, from sequential timeout-as-skip to
 * bounded-parallel generation with real per-org retry.
 *
 * DEVIATION FROM PLAN: the plan called for LangGraph's built-in
 * RetryPolicy on the per-org node. A spike test proved this unsafe for a
 * Send-based fan-out: once RetryPolicy exhausts its attempts for ONE
 * branch, the error propagates out of the ENTIRE graph.invoke() call —
 * not just that branch — which would crash action-matrix generation for
 * ALL orgs over one permanently-failing org (worse than today's
 * behavior, where a timeout is isolated to that org). Retry + graceful
 * degrade is therefore hand-rolled inside generateActionsForOrg itself,
 * matching the same "never let the node throw" pattern already proven
 * safe in graphs/social-sentinel-graph.js's retryOne. classifyError/
 * RETRYABLE are still reused from sentinel.js (not a second ad hoc
 * classifier), so the mechanical retry-vs-skip judgment stays unified
 * with what governs social-media retries.
 *
 * cfg/cb/orgSummary/emerging threaded via config.configurable, same
 * pattern as the other two graphs. No checkpointer needed (same
 * reasoning — single continuous run(), no interrupt()).
 */

const { StateGraph, Annotation, START, END, Send } = require('@langchain/langgraph');
const ClaudeClient = require('../claude-client');
const Sentinel = require('../sentinel');

const MAX_ATTEMPTS = 3;
const PER_ORG_TIMEOUT = 90000; // same 90s ceiling per attempt as the original

const State = Annotation.Root({
  ORGS: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  orgLines: Annotation({ reducer: (_a, b) => b, default: () => ({}) }),
  gapTopics: Annotation({ reducer: (_a, b) => b, default: () => 'none' }),
  // Per-Send-branch payload fields (one generateActionsForOrg invocation
  // per org runs with these overridden to that org's values).
  org: Annotation({ reducer: (_a, b) => b, default: () => undefined }),
  line: Annotation({ reducer: (_a, b) => b, default: () => undefined }),
  actions: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

// 1. prepareOrgLines — pipeline.js's original orgLines/gapTopics build
//    (STEP 5b action-matrix block), unchanged logic.
async function prepareOrgLines(state, config) {
  const { cb, orgSummary, emerging } = config.configurable;
  cb?.('  Action matrix (per-org batches)...');
  const gapTopics = emerging.map((e) => e.topic).join(', ') || 'none';
  const orgLines = Object.fromEntries(
    orgSummary.split('\n').map((line) => [line.split(':')[0].trim(), line]),
  );
  return { orgLines, gapTopics };
}

// Conditional edge after prepareOrgLines — dispatches one Send per org,
// each carrying that org's pre-built data line + the shared gap topics.
function fanOutToOrgs(state) {
  return state.ORGS.map((org) => new Send('generateActionsForOrg', {
    org,
    line: state.orgLines[org] || `${org}: no data`,
    gapTopics: state.gapTopics,
  }));
}

// 2. generateActionsForOrg — invoked once per org in parallel via Send.
//    Same prompt as the original; up to MAX_ATTEMPTS tries with a short
//    pause between, stopping early for non-retryable classifications
//    (matching RETRYABLE from sentinel.js — the same set that governs
//    social-media retry eligibility). NEVER throws — always resolves to
//    an actions array (possibly empty), so one org's permanent failure
//    can't take down the other Send branches or the whole graph run.
async function generateActionsForOrg(state, config) {
  const { cb, cfg } = config.configurable;
  const { org, line, gapTopics } = state;
  const prompt = `Generate exactly 4 strategic actions for "${org}" based on Indian AQ media, AEO, and social media data.\n\nORG DATA:\n${line}\n\nWhite-space gap topics (AQ conversations this org is absent from): ${gapTopics}\n\nRules:\n- Each action must be specific to the data above, not generic.\n- priority must be one of: Fix Now, Leverage, Optimise, Invest\n- area must be one of: Media, Topics, Narrative, AEO, Social\n- rationale: 1-2 sentences citing the specific numbers above\n\nReturn ONLY a JSON array of exactly 4 objects:\n[{"org":"${org}","priority":"...","area":"...","action":"...","rationale":"..."}]`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await Promise.race([
        ClaudeClient.callClaude(prompt, cfg.CLAUDE_KEY, 600, ClaudeClient.CLAUDE_CLASSIFY_MODEL),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PER_ORG_TIMEOUT)),
      ]);
      const parsed = ClaudeClient.parseJ(r) || [];
      if (parsed.length) {
        cb?.(`    ${org}: ${parsed.length} actions${attempt > 1 ? ` (attempt ${attempt})` : ''}`, 'ok');
        return { actions: parsed };
      }
      cb?.(`    ${org}: empty response (attempt ${attempt}/${MAX_ATTEMPTS})`, 'warn');
    } catch (e) {
      const reason = Sentinel.classifyError(e);
      cb?.(`    ${org}: failed (${e.message}) (attempt ${attempt}/${MAX_ATTEMPTS})`, 'warn');
      if (!Sentinel.RETRYABLE.has(reason)) break; // non-transient — retrying won't help
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, 500));
  }
  cb?.(`    ${org}: giving up after all attempts — 0 actions for this org`, 'warn');
  return { actions: [] };
}

// 3. finalize — pipeline.js's original closing log line.
async function finalize(state, config) {
  const { cb } = config.configurable;
  cb?.(`  Action matrix: ${state.actions.length} actions total`, state.actions.length > 0 ? 'ok' : 'err');
  return {};
}

const graph = new StateGraph(State)
  .addNode('prepareOrgLines', prepareOrgLines)
  .addNode('generateActionsForOrg', generateActionsForOrg)
  .addNode('finalize', finalize)
  .addEdge(START, 'prepareOrgLines')
  .addConditionalEdges('prepareOrgLines', fanOutToOrgs)
  .addEdge('generateActionsForOrg', 'finalize')
  .addEdge('finalize', END)
  .compile();

/** Returns { actions } — pipeline.js assigns from this in place of its
 * original inline per-org loop. */
async function run({ cfg, ORGS, orgSummary, emerging, cb }) {
  const finalState = await graph.invoke(
    { ORGS },
    { configurable: { cfg, orgSummary, emerging, cb }, recursionLimit: 15 },
  );
  return { actions: finalState.actions };
}

module.exports = { run, graph, MAX_ATTEMPTS };
