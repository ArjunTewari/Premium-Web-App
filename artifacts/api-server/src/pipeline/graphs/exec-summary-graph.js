'use strict';
/**
 * exec-summary-graph.js — LangGraph.js upgrade of pipeline.js's STEP 5b
 * exec-summary generation from diagnose-only to diagnose→regenerate→
 * re-validate. Sentinel.validateExecSummary() previously only flagged
 * numeric mismatches as a warning; this graph actually closes the loop by
 * regenerating with explicit corrective feedback built from the exact
 * mismatch it found, bounded to MAX_RETRIES extra attempts.
 *
 * cfg/cb/data/ORGS/DATE_FROM/DATE_TO/orgSummary threaded via
 * config.configurable, same pattern as graphs/social-sentinel-graph.js.
 * No checkpointer needed (same reasoning as Graph 1 — single continuous
 * run(), no interrupt(), no cross-process resume).
 */

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
// Referenced as ClaudeClient.callClaude(...)/.parseJ(...) at call time
// (not destructured at module load) so mocking claude-client.js's exports
// — e.g. in tests — is actually respected. Destructuring here would freeze
// a reference to whatever the functions were at require() time.
const ClaudeClient = require('../claude-client');
const Sentinel = require('../sentinel');

const MAX_RETRIES = 2; // worst case: 1 initial + 2 corrective = 3 total Claude calls

const State = Annotation.Root({
  execF: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  execAudit: Annotation({ reducer: (_a, b) => b, default: () => null }),
  retryCount: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
});

// Identical wording to pipeline.js's original STEP 5b prompt — must stay
// byte-identical on the base (first-attempt) path for behavioral parity.
function buildPrompt({ ORGS, DATE_FROM, DATE_TO, orgSummary }, execAudit) {
  const base = `Write 3 comparative findings for a media intelligence report comparing these orgs on Indian air quality coverage ${DATE_FROM} to ${DATE_TO}.\nOrgs: ${ORGS.join(", ")}\n\nDATA (includes AEO/LLM visibility and social media):\n${orgSummary}\n\nRULES — follow strictly:\n- State facts directly. NEVER use inferential or interpretive language: banned words include "reflects", "indicates", "demonstrates", "shows", "suggests", "implies", "highlights", "underscores", "signals", "points to", "speaks to", "reveals", "evidences".\n- Do NOT editorialize about what numbers mean. Report the numbers and let the reader draw conclusions.\n- Cite ONLY directly observable counts and scores. NEVER use these phrases: "authoritative tone", "institutional credibility", "greater credibility", "more trustworthy".\n- When EITHER compared value is below 10, use raw counts (e.g. "4 vs 1 articles") not percentages. Use "Nx" ratios only when BOTH values are ≥5.\n- Each headline max 12 words. Each detail 2-3 sentences with specific numbers only.\n- section_ref must be one of: "§03 AQ Press Analytics", "§05 Topic Ownership", "§06 Narrative Position", "§07 Citation Quality", "§AEO LLM Visibility", "§Social Media".\nReturn ONLY JSON array of 3: [{"headline":"...","detail":"...","section_ref":"§03 AQ Press Analytics"}]`;

  if (!execAudit || !execAudit.issues.length) return base;

  // Corrective feedback built directly from validateExecSummary's own
  // diagnostic fields — turns existing diagnosis output into regeneration
  // input rather than inventing new feedback logic.
  const feedback = execAudit.issues
    .map((iss) => `Finding #${iss.findingIdx + 1} claimed ${iss.claimed} ${iss.metric} for ${iss.org}, but the correct value from the DATA above is ${iss.actual}.`)
    .join(' ');
  return `${base}\n\nYour previous attempt had errors — ${feedback} Regenerate all 3 findings using ONLY the exact numbers shown in DATA above.`;
}

// 1. generateSummary — pipeline.js's original callClaude+parseJ block
//    (STEP 5b), extended to build a corrective prompt when looping back
//    from a failed fact-check. retryCount only increments on a corrective
//    pass (execAudit had issues going in) — stays 0 on the very first call.
async function generateSummary(state, config) {
  const { cb, cfg, ORGS, DATE_FROM, DATE_TO, orgSummary } = config.configurable;
  const isCorrective = !!(state.execAudit && state.execAudit.issues.length);
  const retryCount = isCorrective ? state.retryCount + 1 : state.retryCount;

  cb?.(isCorrective ? `  Executive summary (corrective retry ${retryCount}/${MAX_RETRIES})...` : '  Executive summary...');
  try {
    const prompt = buildPrompt({ ORGS, DATE_FROM, DATE_TO, orgSummary }, state.execAudit);
    const r = await ClaudeClient.callClaude(prompt, cfg.CLAUDE_KEY, 1200);
    const execF = ClaudeClient.parseJ(r) || [];
    cb?.(`  ${execF.length} findings`, execF.length > 0 ? 'ok' : 'err');
    return { execF, retryCount };
  } catch (e) {
    cb?.(`  exec err: ${e.message}`, 'err');
    // Keep the previous execF (if any) rather than wiping it on a failed
    // regeneration attempt — matches "degrade to last-known-good" intent.
    return { execF: state.execF, retryCount };
  }
}

// 2. factCheck — pipeline.js's original SENTINEL exec-summary block
//    (unchanged logic, reused verbatim from Sentinel.validateExecSummary).
async function factCheck(state, config) {
  const { cb, data, ORGS } = config.configurable;
  let execAudit = { issues: [], checked: 0 };
  try {
    execAudit = Sentinel.validateExecSummary(state.execF, data, ORGS);
    if (execAudit.issues.length) {
      cb?.(`  SENTINEL · exec summary: ${execAudit.issues.length}/${execAudit.checked} numeric claim(s) don't match computed data`, 'warn');
      execAudit.issues.forEach((iss) =>
        cb?.(`    finding #${iss.findingIdx + 1} (${iss.org}): claims ${iss.claimed} ${iss.metric}, actual ${iss.actual}`, 'warn'),
      );
    } else {
      cb?.(`  SENTINEL · exec summary: ${execAudit.checked} numeric claim(s) verified against computed data ✓`, 'ok');
    }
  } catch (e) {
    cb?.(`  SENTINEL · exec summary audit skipped: ${e.message}`, 'warn');
  }
  return { execAudit };
}

// Clean pass, or an audit error (fails open, matching original behavior) →
// END. Issues found and retries remain → loop back to generateSummary with
// the mismatch as corrective feedback. Issues remain after MAX_RETRIES →
// END anyway — factCheck already logged the warning on this final attempt,
// so the report renders exactly like today's diagnose-only behavior
// (degrade to the best-available execF + a warning banner), just only
// after having tried to fix it first.
function routeAfterFactCheck(state) {
  if (!state.execAudit.issues.length) return END;
  if (state.retryCount < MAX_RETRIES) return 'generateSummary';
  return END;
}

const graph = new StateGraph(State)
  .addNode('generateSummary', generateSummary)
  .addNode('factCheck', factCheck)
  .addEdge(START, 'generateSummary')
  .addEdge('generateSummary', 'factCheck')
  .addConditionalEdges('factCheck', routeAfterFactCheck)
  .compile();

/**
 * Returns { execF, execAudit } — pipeline.js assigns both from this in
 * place of its original inline generate+audit block.
 */
async function run({ cfg, data, ORGS, DATE_FROM, DATE_TO, orgSummary, cb }) {
  const finalState = await graph.invoke(
    {},
    { configurable: { cfg, data, ORGS, DATE_FROM, DATE_TO, orgSummary, cb }, recursionLimit: 15 },
  );
  let execF = finalState.execF;
  let execAudit = finalState.execAudit;

  // Deterministic final patch: regeneration (above) tries to get Claude to
  // restate the right number, but there's no need to gamble on that when the
  // correct value is already known — every issue with an unambiguous single
  // field (articles/AEO/social; NOT the two-field "%" case, which stays
  // flagged rather than guessed) gets its digits spliced directly into the
  // finding text. Runs regardless of whether the loop above converged or hit
  // MAX_RETRIES, so a report never ships a known-wrong number just because
  // Claude didn't happen to restate it correctly within the retry budget.
  if (execAudit.issues.some((iss) => iss.correctedValue != null)) {
    const corrected = Sentinel.applyCorrections(execF, execAudit.issues);
    const reAudit = Sentinel.validateExecSummary(corrected, data, ORGS);
    const fixedCount = execAudit.issues.length - reAudit.issues.length;
    cb?.(`  SENTINEL · exec summary: auto-corrected ${fixedCount} numeric claim(s) directly in the text`, fixedCount > 0 ? 'ok' : 'warn');
    execF = corrected;
    execAudit = reAudit;
  }

  return { execF, execAudit };
}

module.exports = { run, graph, MAX_RETRIES };
