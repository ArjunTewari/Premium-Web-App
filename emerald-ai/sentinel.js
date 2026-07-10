'use strict';
/**
 * sentinel.js — Agentic validation layer for the AQ intelligence pipeline.
 *
 * Implements a validate → diagnose → repair → re-validate loop:
 *
 *   SOCIAL  socialSentinel()        inspects every org × platform fetch result,
 *                                   diagnoses zeros (failure vs filter vs genuine),
 *                                   retries transient failures, recognises quota
 *                                   exhaustion (no pointless retries), and logs a
 *                                   data-health verdict for the run transcript.
 *
 *   REPORT  auditSectionNumbering() post-build audit that renumbers "Section NN"
 *                                   labels contiguously in document order, so
 *                                   structural edits to the template can never
 *                                   ship a numbering gap again.
 *
 * Design rule: failure and absence are never conflated. A failed API call keeps
 * its `failed` flag all the way into the rendered report; only a completed fetch
 * may claim a zero.
 */

// ── Error classification ─────────────────────────────────────────────────────

function classifyError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || err || '').toLowerCase();
  if (status === 429 || /rate.?limit|quota|too many request/.test(msg)) return 'rate_limit';
  if (status === 401 || status === 403 || /unauthori[sz]|forbidden|invalid.*key/.test(msg)) return 'auth';
  if (/timeout|timed out|econnaborted/.test(msg)) return 'timeout';
  if (status === 404 || /not found/.test(msg)) return 'not_found';
  if (/econnrefused|enotfound|network|socket/.test(msg)) return 'network';
  return 'unknown';
}

const RETRYABLE = new Set(['timeout', 'network', 'unknown']);

// ── Social: validate ─────────────────────────────────────────────────────────

const PLATFORMS = [
  { key: 'li', name: 'LinkedIn' },
  { key: 'tw', name: 'X/Twitter' },
  { key: 'ig', name: 'Instagram' },
];

/**
 * Diagnose why a single completed (non-failed) platform fetch produced zero,
 * using only the funnel counts the fetcher already recorded (fetched →
 * afterAuthor → inRange → final) — no extra API calls. Shared by
 * validateSocial() (for the run-transcript log) and the HTML renderer (for
 * per-cell tooltips), so every zero column gets the same verified reasoning
 * whether it's read from the console or the report.
 */
function diagnoseZero(p, platformName) {
  if ((p.fetched || 0) === 0) {
    return `API returned no posts for the query/handle — verify the ${platformName} handle`;
  }
  if (p.afterAuthor !== undefined && p.afterAuthor === 0) {
    return platformName === 'LinkedIn'
      ? `all ${p.fetched} fetched posts were reposts and/or failed the author-match check — no verified original content from this org's own page in this window`
      : `authorship filter dropped all ${p.fetched} fetched posts — handle likely doesn't match the API's author field`;
  }
  if ((p.inRangeCount || 0) === 0) {
    return `all ${p.fetched} fetched posts fall outside the report date window — zero is genuine for this window`;
  }
  if (p.truncated) {
    return `${p.inRangeCount} posts in window but none matched AQ keywords, AND the fetch was capped before reaching the full date window (org posts frequently) — zero is not fully verified, may be a coverage gap`;
  }
  return `${p.inRangeCount} posts in window but none matched AQ keywords — zero is genuine`;
}

/**
 * Inspect raw APIdirect results and return anomalies, each with a diagnosis.
 * Zero API calls — diagnosis is derived from the funnel counts the fetchers
 * record (fetched → afterAuthor → inRange → final).
 */
function validateSocial(rawResults) {
  const anomalies = [];
  for (const r of rawResults) {
    for (const { key, name } of PLATFORMS) {
      const p = r[key];
      if (!p || p.noHandle) continue; // no handle configured — zero is expected
      if (p.failed) {
        anomalies.push({
          type: 'fetch_failed', org: r.org, platform: key, platformName: name,
          reason: p.failReason || 'unknown',
          diagnosis: `${name} API call failed (${p.failReason || 'unknown'}): ${p.failMessage || ''}`.trim(),
          retryable: RETRYABLE.has(p.failReason),
        });
      } else if (p.postCount === 0) {
        anomalies.push({
          type: 'zero_diagnosed', org: r.org, platform: key, platformName: name,
          diagnosis: diagnoseZero(p, name), retryable: false,
        });
      }
    }
  }
  return anomalies;
}

// ── Social: repair loop ──────────────────────────────────────────────────────

/**
 * The agentic loop for social collection — LEGACY hand-rolled implementation.
 *   1. Validate all results.
 *   2. Diagnose: if most failures are rate-limits, declare quota exhaustion
 *      (retrying burns the remaining budget for nothing).
 *   3. Repair: sequentially retry retryable failures with backoff.
 *   4. Re-validate and log the final data-health verdict.
 * Returns rawResults with retried entries patched in place.
 *
 * Kept intact (unused by default) as the rollback path for the LangGraph
 * port in graphs/social-sentinel-graph.js — see socialSentinel() below.
 */
async function socialSentinelLegacy(rawResults, { cfg, orgHandles, cb }) {
  const APIdirect = require('./apidirect-collector');
  const anomalies = validateSocial(rawResults);
  if (!anomalies.length) {
    cb?.('  SENTINEL · social: all org × platform fetches healthy', 'ok');
    return rawResults;
  }

  const failures = anomalies.filter(a => a.type === 'fetch_failed');
  const diagnosedZeros = anomalies.filter(a => a.type === 'zero_diagnosed');

  cb?.(`\n  SENTINEL · social: ${failures.length} failed fetch(es), ${diagnosedZeros.length} zero(es) diagnosed`, 'head');
  for (const a of diagnosedZeros) cb?.(`    ${a.org} · ${a.platformName}: ${a.diagnosis}`, 'warn');

  if (!failures.length) return rawResults;

  // Diagnose quota exhaustion: if half or more failures are rate-limits,
  // retrying is counterproductive — mark unavailable and stop.
  const rateLimited = failures.filter(a => a.reason === 'rate_limit');
  if (rateLimited.length >= Math.max(2, failures.length / 2)) {
    cb?.(`    VERDICT: API quota exhausted (${rateLimited.length}/${failures.length} rate-limit errors) — affected cells will render as unavailable, NOT zero. No retries (would burn remaining quota).`, 'err');
    return rawResults;
  }

  // Repair: retry transient failures one at a time with a pause between each.
  const retryable = failures.filter(a => a.retryable);
  const skipped = failures.length - retryable.length;
  if (skipped > 0) cb?.(`    ${skipped} failure(s) not retryable (auth/rate-limit) — left as unavailable`, 'warn');
  if (!retryable.length) return rawResults;

  cb?.(`    Repairing: retrying ${retryable.length} transient failure(s) sequentially…`);
  const aqKw = APIdirect.buildAqKeywords(cfg.SCOPE_KEYWORDS);
  const dateRange = { from: APIdirect.parseDate(cfg.DATE_FROM), to: APIdirect.parseDate(cfg.DATE_TO) };
  const fetcherFor = { li: APIdirect.fetchLinkedIn, tw: APIdirect.fetchTwitter, ig: APIdirect.fetchInstagram };
  const handleKey = { li: 'linkedin', tw: 'twitter', ig: 'instagram' };

  let repaired = 0;
  for (const a of retryable.slice(0, 8)) { // cap retries to conserve quota
    const entry = rawResults.find(r => r.org === a.org);
    const handle = (orgHandles[a.org] || {})[handleKey[a.platform]] || null;
    if (!entry || !handle) continue;
    await new Promise(res => setTimeout(res, 1200));
    try {
      const fresh = await fetcherFor[a.platform](a.org, handle, cfg.APIDIRECT_KEY, dateRange, aqKw, cb);
      if (!fresh.failed) {
        entry[a.platform] = fresh;
        repaired++;
        cb?.(`    ✓ ${a.org} · ${a.platformName}: retry succeeded (${fresh.postCount} posts)`, 'ok');
      } else {
        cb?.(`    ✗ ${a.org} · ${a.platformName}: retry failed again (${fresh.failReason})`, 'warn');
      }
    } catch (e) {
      cb?.(`    ✗ ${a.org} · ${a.platformName}: retry threw (${e.message})`, 'warn');
    }
  }

  // Re-validate for the final verdict.
  const remaining = validateSocial(rawResults).filter(a => a.type === 'fetch_failed');
  cb?.(`    VERDICT: ${repaired} repaired, ${remaining.length} still unavailable — unavailable cells render as ✕, not 0`, remaining.length ? 'warn' : 'ok');
  return rawResults;
}

/**
 * Public entry point — dispatches to the LangGraph port by default (see
 * graphs/social-sentinel-graph.js), same signature/return shape as the
 * legacy function. Set SENTINEL_ENGINE=legacy to fall back to the
 * hand-rolled implementation without a code change (first-ever LangGraph
 * adoption in this codebase — kept trivially revertible).
 *
 * Lazy require (not at module top) avoids a circular require: the graph
 * module itself requires validateSocial from this file.
 */
async function socialSentinel(rawResults, ctx) {
  if (process.env.SENTINEL_ENGINE === 'legacy') {
    return socialSentinelLegacy(rawResults, ctx);
  }
  const graph = require('./graphs/social-sentinel-graph');
  return graph.run(rawResults, ctx);
}

// ── Report: section numbering audit + auto-fix ──────────────────────────────

/**
 * Renumber "Section NN[letter]" labels contiguously in document order.
 * Sub-lettered groups (02a/02b/02c) keep sharing one base number. Returns the
 * fixed HTML and the list of relabellings applied — an empty list means the
 * template was already contiguous.
 */
function auditSectionNumbering(html) {
  const fixes = [];
  let lastOrigBase = null;
  let current = 0;
  const fixed = html.replace(/(>\s*Section\s+)(\d+)([a-z]?)/g, (m, pre, num, letter) => {
    if (num !== lastOrigBase) { current += 1; lastOrigBase = num; }
    const label = String(current).padStart(2, '0');
    if (label !== num) fixes.push(`Section ${num}${letter} → Section ${label}${letter}`);
    return `${pre}${label}${letter}`;
  });
  return { html: fixed, fixes: [...new Set(fixes)] };
}

// ── Executive Summary: numeric fact-check ────────────────────────────────────

/**
 * Fact-check the AI-generated Executive Summary findings against the actual
 * computed org data. Extracts unit-tagged numbers (articles, %, /10 social,
 * AEO score) near each org mention in the finding text and verifies each one
 * matches a real field on that org.
 *
 * This exists because the exec-summary prompt hands Claude pre-formatted
 * data lines, and a labeling bug in that data (or a hallucination on
 * Claude's part) both surface the same way: a specific number stated as fact
 * that doesn't match anything the pipeline actually computed. Concretely,
 * this is what caught the AEO 0–100 "score" being restated as a literal
 * "mentions" count.
 *
 * Deliberately conservative: only unit-tagged numbers are checked (bare
 * digits are ignored — dates, ranks, section refs would be noise), and a
 * number only counts as a mismatch if it fails to match ANY plausible field
 * on the nearest-mentioned org within a small window. False negatives are
 * acceptable here; false positives would make the note useless.
 */
function validateExecSummary(execF, data, ORGS) {
  if (!Array.isArray(execF) || !execF.length) return { issues: [], checked: 0 };

  // Longest-name-first so a short org name can't shadow a longer one that
  // contains it as a substring.
  const orgsByLen = [...ORGS].sort((a, b) => b.length - a.length);

  // Unit patterns are bidirectional where natural phrasing can go either way
  // ("18 AEO mentions" vs "AEO score of 18") — a capture can land in group 1
  // or group 2 depending on which alternative matched.
  // 'd' flag (match indices) lets us know exactly which characters a capture
  // group matched — needed both to dedup overlapping patterns below and to
  // splice a corrected value directly into the finding text later.
  const UNIT_PATTERNS = [
    { re: /(\d+(?:\.\d+)?)\s*articles?\b/gid, fields: ['total'], label: 'articles' },
    { re: /(\d+(?:\.\d+)?)\s*%/gd, fields: ['dataPct', 'authPct'], label: '%' },
    { re: /(\d+(?:\.\d+)?)\s*\/\s*10\b/gd, fields: ['social'], label: '/10 social' },
    { re: /(\d+(?:\.\d+)?)\s*\/\s*100\b/gd, fields: ['aeo'], label: '/100 AEO score' },
    { re: /(\d+(?:\.\d+)?)\s*AEO\b|AEO\D{0,20}?(\d+(?:\.\d+)?)/gid, fields: ['aeo'], label: 'AEO' },
  ];

  // A generic plural like "7 organizations registered 0 mentions" refers to
  // an unnamed aggregate, not any single tracked org — if this phrase sits
  // closer to a number than any named org does, the number isn't attributable
  // to a specific org and must be skipped rather than pinned on whichever
  // named org happens to appear earlier in the sentence.
  const GENERIC_AGGREGATE_RE = /\borgani[sz]ations?\b|\borgs\b/gi;

  const issues = [];
  let checked = 0;

  execF.forEach((finding, fi) => {
    const text = `${finding.headline || ''}. ${finding.detail || ''}`;

    // Index every org-name occurrence so numbers can be attributed to one.
    const orgHits = [];
    for (const org of orgsByLen) {
      let idx = text.indexOf(org);
      while (idx !== -1) {
        orgHits.push({ org, pos: idx });
        idx = text.indexOf(org, idx + org.length);
      }
    }
    if (!orgHits.length) return;

    const genericHits = [];
    GENERIC_AGGREGATE_RE.lastIndex = 0;
    let gm;
    while ((gm = GENERIC_AGGREGATE_RE.exec(text))) genericHits.push(gm.index);

    // Patterns can overlap on the same substring (e.g. "0/100 AEO" is matched
    // whole by the "/100" pattern AND partially re-matched — just the "100"
    // — by the "AEO" pattern's "digits-before-AEO" alternative, producing two
    // contradictory issues for one real claim). Track which character ranges
    // are already claimed (patterns run in array order, so more specific
    // patterns like "/100" go first and win) and skip a later pattern's match
    // if it overlaps.
    const consumedRanges = [];
    const overlapsConsumed = (s, e) => consumedRanges.some((r) => s < r.end && e > r.start);

    for (const { re, fields, label } of UNIT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const groupIdx = m[1] !== undefined ? 1 : 2;
        const val = parseFloat(m[groupIdx]);
        if (Number.isNaN(val)) continue;
        // Dedup on the WHOLE match span ("0/100"), not just the captured
        // digits ("0") — the AEO pattern's competing match ("100 AEO") only
        // overlaps the /100 pattern's captured "0" via the surrounding "/100"
        // text, not the digit itself, so checking just the capture would miss
        // the collision entirely (this was the actual bug: whole-match spans
        // for "0/100" and "100 AEO" overlap on the shared "100", but their
        // individual capture groups — "0" vs "100" — don't overlap at all).
        const [wStart, wEnd] = m.indices[0];
        if (overlapsConsumed(wStart, wEnd)) continue;
        consumedRanges.push({ start: wStart, end: wEnd });
        const [gStart, gEnd] = m.indices[groupIdx];

        // Attribution favors the closest PRECEDING org mention — this
        // report's writing style is consistently "Org verb N unit" (e.g.
        // "Centre for Science and Environment accumulated 18 AEO mentions"),
        // so a number almost always follows the org it describes, not
        // precedes the next one. Nearest-by-absolute-distance would
        // misattribute a trailing number to whichever org happens to be
        // named next in the same sentence.
        let nearestOrg = null, bestDist = Infinity;
        for (const h of orgHits) {
          if (h.pos > m.index) continue;
          const d = m.index - h.pos;
          if (d < bestDist) { bestDist = d; nearestOrg = h.org; }
        }
        if (!nearestOrg) {
          for (const h of orgHits) {
            const d = h.pos - m.index;
            if (d > 0 && d < bestDist) { bestDist = d; nearestOrg = h.org; }
          }
        }

        // High-confidence override: "N/10 (OrgName)" / "N (OrgName)" — an org
        // name in parentheses immediately after the number is unambiguous and
        // takes priority over everything else, including the generic-aggregate
        // check below (a stray "organizations" earlier in the sentence must
        // not block an adjacent, explicit parenthetical attribution).
        const afterText = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
        const parenMatch = afterText.match(/^\s*\(([^)]+)\)/);
        let parenOverride = false;
        if (parenMatch) {
          const namedInParen = orgsByLen.find((o) => parenMatch[1].includes(o));
          if (namedInParen) { nearestOrg = namedInParen; bestDist = 0; parenOverride = true; }
        }

        // If a generic aggregate phrase ("N organizations") sits closer to
        // this number than the named org does, the claim is about an unnamed
        // group — not attributable to nearestOrg. Skip it (unless the paren
        // override above already gave an unambiguous attribution).
        if (!parenOverride) {
          const nearestGenericDist = genericHits
            .filter((gp) => gp <= m.index)
            .reduce((min, gp) => Math.min(min, m.index - gp), Infinity);
          if (nearestGenericDist < bestDist) continue;
        }

        if (!nearestOrg || bestDist > 120) continue; // too far to attribute confidently

        checked++;
        const truth = data[nearestOrg];
        if (!truth) continue;
        const matches = fields.some((f) => truth[f] != null && Math.abs(truth[f] - val) < 0.6);
        if (!matches) {
          // Only auto-correctable when the unit maps to exactly one field —
          // "%" maps to either dataPct or authPct, so which one the finding
          // meant is ambiguous and must stay a flagged issue, not a guess.
          const singleField = fields.length === 1 ? fields[0] : null;
          const correctedValue = singleField != null && truth[singleField] != null
            ? String(truth[singleField]) : null;
          issues.push({
            findingIdx: fi,
            headline: finding.headline || '',
            org: nearestOrg,
            claimed: val,
            metric: label,
            actual: fields.map((f) => `${f}=${truth[f] ?? 'n/a'}`).join(', '),
            matchStart: gStart,
            matchEnd: gEnd,
            correctedValue,
          });
        }
      }
    }
  });

  return { issues, checked };
}

/**
 * Deterministically splice the correct computed value into finding text for
 * every issue that has an unambiguous correctedValue (see validateExecSummary
 * — single-field units only, not the two-field "%" case). Used as the final
 * step after the regenerate-and-recheck loop in graphs/exec-summary-graph.js
 * either converges or exhausts its retries: rather than leaving a
 * known-wrong number in the report with just a warning, patch it directly.
 * Returns a NEW execF array (does not mutate the input) — findings with no
 * correctable issues are returned unchanged (same object reference).
 */
function applyCorrections(execF, issues) {
  const byFinding = new Map();
  for (const iss of issues) {
    if (iss.correctedValue == null) continue;
    if (!byFinding.has(iss.findingIdx)) byFinding.set(iss.findingIdx, []);
    byFinding.get(iss.findingIdx).push(iss);
  }
  if (!byFinding.size) return execF;

  return execF.map((finding, fi) => {
    const fixes = byFinding.get(fi);
    if (!fixes) return finding;
    const headline = finding.headline || '';
    const detail = finding.detail || '';
    const boundary = headline.length + 2; // matches the ". " joiner used to build `text` during detection

    let newHeadline = headline;
    const inHeadline = fixes.filter((f) => f.matchStart < headline.length).sort((a, b) => b.matchStart - a.matchStart);
    for (const f of inHeadline) {
      newHeadline = newHeadline.slice(0, f.matchStart) + f.correctedValue + newHeadline.slice(f.matchEnd);
    }

    let newDetail = detail;
    const inDetail = fixes.filter((f) => f.matchStart >= boundary).sort((a, b) => b.matchStart - a.matchStart);
    for (const f of inDetail) {
      const s = f.matchStart - boundary, e = f.matchEnd - boundary;
      newDetail = newDetail.slice(0, s) + f.correctedValue + newDetail.slice(e);
    }

    return { ...finding, headline: newHeadline, detail: newDetail };
  });
}

module.exports = { classifyError, RETRYABLE, diagnoseZero, validateSocial, socialSentinel, socialSentinelLegacy, auditSectionNumbering, validateExecSummary, applyCorrections };
