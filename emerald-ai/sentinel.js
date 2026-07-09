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
        // Completed fetch that produced zero — diagnose which stage zeroed it.
        let diagnosis;
        if ((p.fetched || 0) === 0) {
          diagnosis = `API returned no posts for the query/handle — verify the ${name} handle`;
        } else if (p.afterAuthor !== undefined && p.afterAuthor === 0) {
          diagnosis = `authorship filter dropped all ${p.fetched} fetched posts — handle likely doesn't match the API's author field`;
        } else if ((p.inRangeCount || 0) === 0) {
          diagnosis = `all ${p.fetched} fetched posts fall outside the report date window — zero is genuine for this window`;
        } else {
          diagnosis = `${p.inRangeCount} posts in window but none matched AQ keywords — zero is genuine`;
        }
        anomalies.push({
          type: 'zero_diagnosed', org: r.org, platform: key, platformName: name,
          diagnosis, retryable: false,
        });
      }
    }
  }
  return anomalies;
}

// ── Social: repair loop ──────────────────────────────────────────────────────

/**
 * The agentic loop for social collection.
 *   1. Validate all results.
 *   2. Diagnose: if most failures are rate-limits, declare quota exhaustion
 *      (retrying burns the remaining budget for nothing).
 *   3. Repair: sequentially retry retryable failures with backoff.
 *   4. Re-validate and log the final data-health verdict.
 * Returns rawResults with retried entries patched in place.
 */
async function socialSentinel(rawResults, { cfg, orgHandles, cb }) {
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

module.exports = { classifyError, validateSocial, socialSentinel, auditSectionNumbering };
