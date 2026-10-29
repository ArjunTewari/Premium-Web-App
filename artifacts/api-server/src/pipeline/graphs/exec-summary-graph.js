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

// No regeneration: a second call costs about a minute and gambles on the model getting the number right. A finding whose
// numbers cannot be verified is REPLACED by one built from the data (exec-facts.js), which is true by construction.
const MAX_RETRIES = 0;

const State = Annotation.Root({
  execF: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  execAudit: Annotation({ reducer: (_a, b) => b, default: () => null }),
  retryCount: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
});

// Identical wording to pipeline.js's original STEP 5b prompt — must stay
// byte-identical on the base (first-attempt) path for behavioral parity.
function buildPrompt({ ORGS, DATE_FROM, DATE_TO, orgSummary, reviewFeedback }, execAudit) {
  const base = `Write 3 comparative findings for a media intelligence report comparing these orgs on Indian air quality coverage ${DATE_FROM} to ${DATE_TO}.\nOrgs: ${ORGS.join(", ")}\n\nDATA (includes AEO/LLM visibility and social media):\n${orgSummary}\n\nRULES — follow strictly:\n- State facts directly. NEVER use inferential or interpretive language: banned words include "reflects", "indicates", "demonstrates", "shows", "suggests", "implies", "highlights", "underscores", "signals", "points to", "speaks to", "reveals", "evidences".\n- Do NOT editorialize about what numbers mean. Report the numbers and let the reader draw conclusions.\n- Cite ONLY directly observable counts and scores. NEVER use these phrases: "authoritative tone", "institutional credibility", "greater credibility", "more trustworthy".\n- When EITHER compared value is below 10, use raw counts (e.g. "4 vs 1 articles") not percentages. Use "Nx" ratios only when BOTH values are ≥5.\n- Each headline max 12 words. Each detail 2-3 sentences with specific numbers only.\n- When you list organisations that share a value (for example every organisation at 0/10), use the FACTS lines: name all of them or give only the count. An organisation whose line says a cell was not collected has a score that counts that cell as 0; say so, and do not present it as a measured zero.\n- section_ref must be one of: "§03 AQ Press Analytics", "§05 Topic Ownership", "§06 Narrative Position", "§07 Citation Quality", "§AEO LLM Visibility", "§Social Media".\nReturn ONLY JSON array of 3: [{"headline":"...","detail":"...","section_ref":"§03 AQ Press Analytics"}]`;

  const reviewed = reviewFeedback ? `\n\nAn independent reviewer found these problems in an earlier draft: ${reviewFeedback}\nWrite the 3 findings again so that none of them occurs. Use ONLY the DATA and FACTS lines above.` : '';
  if (!execAudit || !execAudit.issues.length) return base + reviewed;

  // Corrective feedback built directly from validateExecSummary's own
  // diagnostic fields — turns existing diagnosis output into regeneration
  // input rather than inventing new feedback logic.
  const feedback = execAudit.issues
    .map((iss) => `Finding #${iss.findingIdx + 1} claimed ${iss.claimed} ${iss.metric} for ${iss.org}, but the correct value from the DATA above is ${iss.actual}.`)
    .join(' ');
  return `${base}${reviewed}\n\nYour previous attempt had errors — ${feedback} Regenerate all 3 findings using ONLY the exact numbers shown in DATA above.`;
}

// 1. generateSummary — pipeline.js's original callClaude+parseJ block
//    (STEP 5b), extended to build a corrective prompt when looping back
//    from a failed fact-check. retryCount only increments on a corrective
//    pass (execAudit had issues going in) — stays 0 on the very first call.
async function generateSummary(state, config) {
  const { cb, cfg, ORGS, DATE_FROM, DATE_TO, orgSummary, feedback } = config.configurable;
  const isCorrective = !!(state.execAudit && state.execAudit.issues.length);
  const retryCount = isCorrective ? state.retryCount + 1 : state.retryCount;

  cb?.(isCorrective ? `  Executive summary (corrective retry ${retryCount}/${MAX_RETRIES})...` : '  Executive summary...');
  try {
    const prompt = buildPrompt({ ORGS, DATE_FROM, DATE_TO, orgSummary, reviewFeedback: feedback }, state.execAudit);
    const r = await ClaudeClient.callClaude(require("../frameworks").fwText(prompt), cfg.CLAUDE_KEY, 1200);
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
async function run({ cfg, data, ORGS, DATE_FROM, DATE_TO, orgSummary, cb, feedback, notCollected }) {
  const finalState = await graph.invoke(
    {},
    { configurable: { cfg, data, ORGS, DATE_FROM, DATE_TO, orgSummary, cb, feedback }, recursionLimit: 15 },
  );
  let execF = finalState.execF;
  let execAudit = finalState.execAudit;
  const ExecFacts = require('../exec-facts');

  // The model's text is NEVER edited. (An earlier version spliced the "correct" number into a sentence it had judged wrong;
  // deciding which organisation a number belongs to is a guess, and a wrong guess wrote false sentences into the report:
  // "ranged from 51 to 51", "collectively published 1 articles", "scored 33/100 and 33/100".)
  // A finding with a number that does not match the computed data cannot be verified, so it is replaced by a finding built
  // from the data itself (exec-facts.js): same section, every number read from the data. If the model wrote nothing at all,
  // the report gets all three. The replacement is logged and recorded in execAudit.replaced.
  const bad = new Set(execAudit.issues.map((iss) => iss.findingIdx));
  if (bad.size || !execF.length) {
    const r = ExecFacts.replace(execF, [...bad], data, ORGS, { notCollected });
    for (const x of r.replaced) cb?.(`  SENTINEL · exec summary: finding "${x.headline}" had a number that could not be verified; replaced by a finding built from the data — "${x.with}"`, 'warn');
    for (const x of r.dropped) cb?.(`  SENTINEL · exec summary: finding "${x.headline}" removed (could not be verified, nothing to replace it with)`, 'warn');
    const dropped = [...execAudit.issues.reduce((m, iss) => m.set(iss.findingIdx, [...(m.get(iss.findingIdx) || []), `${iss.org}: ${iss.claimed} ${iss.metric}, data ${iss.actual}`]), new Map())]
      .map(([i, claims]) => ({ headline: (execF[i] && execF[i].headline) || '', claims }));
    execF = r.execF;
    // What is in the report now must verify clean; anything the checker still objects to is taken out rather than kept.
    const again = Sentinel.validateExecSummary(execF, data, ORGS);
    if (again.issues.length) {
      const stillBad = new Set(again.issues.map((iss) => iss.findingIdx));
      execF = execF.filter((_, i) => !stillBad.has(i));
    }
    execAudit = { ...Sentinel.validateExecSummary(execF, data, ORGS), dropped, replaced: r.replaced };
  }

  return { execF, execAudit };
}

module.exports = { run, graph, MAX_RETRIES };
