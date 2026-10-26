"use strict";
/**
 * checkpoint.js — save what a run collected from the outside world, so it never has
 * to be paid for twice.
 *
 * Steps 1–4b of the pipeline (press corpus, classification, AI-assistant probes,
 * social and YouTube) are the slow, billed part. Their results are written, gzipped,
 * right after step 4b. A later run given that checkpoint skips those steps and starts
 * at scoring, so:
 *   - a run that is aborted or fails after step 4b (audit failure, a Claude hiccup)
 *     can be resumed without fetching again;
 *   - a corrected rule or a changed report layout can be applied to an existing
 *     report's data without any new APIdirect/Exa/OpenAI spend (Claude CLI steps still run).
 *
 * A checkpoint is only usable for the exact same run: same framework, organisations,
 * dates, scope keywords and AI-search questions.
 */

const crypto = require("node:crypto");
const zlib = require("node:zlib");

const VERSION = 1;

function fingerprint(cfg, frameworkId) {
  return {
    framework: frameworkId,
    orgs: [...(cfg.ORGS || [])],
    dateFrom: cfg.DATE_FROM,
    dateTo: cfg.DATE_TO,
    scopeKeywords: [...(cfg.SCOPE_KEYWORDS || [])],
    aeoQueries: [...(cfg.AEO_QUERIES || [])],
  };
}

/** File name: readable part (framework, window, org count) + a hash of the exact inputs. */
function name(fp) {
  const h = crypto.createHash("sha1").update(JSON.stringify({ o: [...fp.orgs].sort(), f: fp.framework, s: fp.scopeKeywords, a: fp.aeoQueries })).digest("hex").slice(0, 8);
  return `CHK-${fp.framework}-${fp.dateFrom}_${fp.dateTo}-${fp.orgs.length}orgs-${h}.json.gz`;
}

/** { framework, dateFrom, dateTo, orgCount } from a checkpoint file name, or null. */
function parseName(n) {
  const m = /^CHK-([a-z-]+)-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})-(\d+)orgs-([0-9a-f]{8})\.json\.gz$/.exec(String(n));
  return m ? { framework: m[1], dateFrom: m[2], dateTo: m[3], orgCount: Number(m[4]), hash: m[5] } : null;
}

function pack(fp, state, cost) {
  const body = { version: VERSION, savedAt: new Date().toISOString(), fingerprint: fp, state, cost: cost || {} };
  return zlib.gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
}

function unpack(buf) {
  let j;
  try { j = JSON.parse(zlib.gunzipSync(buf).toString("utf8")); } catch { throw new Error("the saved data file is damaged or not a checkpoint"); }
  if (!j || j.version !== VERSION || !j.state || !j.fingerprint) throw new Error("the saved data file is from an incompatible version");
  for (const k of ["arts", "cls", "aeoResults", "socialERResults", "youtubeERResults"]) {
    if (j.state[k] === undefined || j.state[k] === null) throw new Error(`the saved data is incomplete (${k} is missing)`);
  }
  return j;
}

/** Reasons the checkpoint cannot be used for this run (empty = it can). */
function mismatch(chk, fp) {
  const a = chk.fingerprint, why = [];
  if (a.framework !== fp.framework) why.push(`subject area ${a.framework} vs ${fp.framework}`);
  if (a.dateFrom !== fp.dateFrom || a.dateTo !== fp.dateTo) why.push(`dates ${a.dateFrom}→${a.dateTo} vs ${fp.dateFrom}→${fp.dateTo}`);
  if (JSON.stringify([...a.orgs].sort()) !== JSON.stringify([...fp.orgs].sort())) why.push("different organisations");
  if (JSON.stringify(a.scopeKeywords) !== JSON.stringify(fp.scopeKeywords)) why.push("different scope keywords");
  if (JSON.stringify(a.aeoQueries) !== JSON.stringify(fp.aeoQueries)) why.push("different AI-search questions");
  return why;
}

/**
 * Whether the saved social results can be counted again under the current rules. Data saved before the
 * posts were kept holds only counts made under the OLD rules (off-topic and repeated posts included), which
 * the audit rejects and which cannot be corrected: it must not be resumed.
 */
function recountable(chk) {
  const res = (chk && chk.state && chk.state.socialERResults) || [];
  const counted = res.some((r) => (r.twData?.postCount || 0) + (r.liData?.postCount || 0) + (r.igData?.postCount || 0) > 0);
  if (!counted) return true; // nothing was counted, so nothing is stale
  return res.some((r) => Array.isArray(r.twData?.rawTweets) || Array.isArray(r.liData?.rawPosts) || Array.isArray(r.igData?.rawPosts));
}

module.exports = { VERSION, fingerprint, name, parseName, pack, unpack, mismatch, recountable };
