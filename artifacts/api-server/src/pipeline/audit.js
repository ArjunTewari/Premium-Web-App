"use strict";
/**
 * audit.js — the last gate before a report is stored or emailed.
 *
 * Two layers, both must pass:
 *   1. checkDeterministic() — plain code. Cross-checks the report's numbers
 *      against each other and against what the report page will show. Cannot be
 *      talked out of a finding.
 *   2. Claude Code CLI (claude-review.js) — a separate model call reads an evidence pack
 *      built from the same data and looks for what the fixed rules do not cover.
 *
 * Any error finding, or an audit that could not be completed, stops the run: no
 * file is written, nothing is stored, nothing is emailed. Warnings are logged and
 * recorded in the report's audit stamp.
 *
 * Why it exists: on 18 Oct 2026 an organisation was reported with 100 X posts that
 * were really 20 posts returned five times, one of them not about the subject.
 * The same fault had gone unnoticed in a September report (45 = 9 x 5).
 */

const Sentinel = require("./sentinel");
const Reviewer = require("./claude-review");

const PLATFORMS = [
  { key: "liData", name: "LinkedIn", fields: ["totalLikes", "totalComments", "totalShares"], htmlRe: /LinkedIn\s*—\s*<span[^>]*>(\d+)\s*(?:AQ\s*|[A-Za-z]+\s*)?posts?/gi },
  { key: "twData", name: "X/Twitter", fields: ["totalLikes", "totalReplies", "totalRetweets"], htmlRe: /X\/Twitter\s*—\s*<span[^>]*>(\d+)\s*tweets?/gi },
  { key: "igData", name: "Instagram", fields: ["totalLikes", "totalComments"], htmlRe: /Instagram\s*—\s*<span[^>]*>(\d+)\s*posts?/gi },
];

const isCount = (n) => Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
const sum = (xs) => xs.reduce((s, v) => s + (Number(v) || 0), 0);

function checkDeterministic({ ORGS, data, socialERResults = [], execF, html = "" }) {
  const errors = [];
  const warnings = [];
  let checks = 0;
  const err = (org, where, issue) => errors.push({ source: "rules", severity: "error", org, where, issue });
  const warn = (org, where, issue) => warnings.push({ source: "rules", severity: "warning", org, where, issue });
  const check = (cond, org, where, issue) => { checks++; if (!cond) err(org, where, issue); return cond; };

  // ── every organisation is present everywhere it should be ──
  for (const org of ORGS) {
    check(!!data[org], org, "scores", "organisation has no scores");
    check(socialERResults.some((r) => r.org === org), org, "social", "organisation has no social result");
  }

  // ── social: counts, repeated posts, off-topic posts, totals ──
  const shown = { liData: [], twData: [], igData: [] };
  for (const r of socialERResults) {
    for (const p of PLATFORMS) {
      const d = r[p.key];
      if (d && d.failed && !d.noHandle) warn(r.org, `${p.name} (social)`, `collection failed; the report shows this cell as unavailable (not as a zero), but the organisation's social score counts it as 0 — a lower bound`);
      if (!d || d.noHandle || d.failed) continue;
      const where = `${p.name} (social)`;
      check(isCount(d.postCount), r.org, where, `post count ${d.postCount} is not a whole number >= 0`);
      if (isCount(d.postCount) && d.postCount > 0) shown[p.key].push(d.postCount);

      const tops = Array.isArray(d.topPosts) ? d.topPosts : [];
      const urls = tops.map((t) => t.url).filter(Boolean);
      check(new Set(urls).size === urls.length, r.org, where, `the same post is listed more than once in its top posts (${urls.length - new Set(urls).size} repeat(s)) — the count is probably inflated`);
      check(tops.length <= (d.postCount || 0), r.org, where, `${tops.length} top posts listed but the post count is ${d.postCount}`);
      check(!(d.postCount > 0 && tops.length === 0), r.org, where, `post count is ${d.postCount} but no post is listed`);

      const untagged = tops.filter((t) => Array.isArray(t.keywords_found) && t.keywords_found.length === 0);
      check(untagged.length === 0, r.org, where, `${untagged.length} counted post(s) contain none of the subject keywords (e.g. ${String(untagged[0]?.snippet || "").slice(0, 80)})`);

      for (const f of p.fields) {
        const topSum = sum(tops.map((t) => t[f === "totalLikes" ? "likes" : f === "totalComments" ? "comments" : f === "totalShares" ? "shares" : f === "totalReplies" ? "replies" : "retweets"]));
        check((Number(d[f]) || 0) >= topSum, r.org, where, `${f} (${d[f]}) is smaller than the total of the top posts alone (${topSum})`);
      }

      // Signature of the 18 Oct fault: a page repeated k times makes every total a multiple of k.
      if (d.postCount >= 10 && d.postCount % 5 === 0 && p.fields.every((f) => (Number(d[f]) || 0) % 5 === 0)) {
        warn(r.org, where, `post count and engagement totals are all multiples of 5 (${d.postCount} posts) — the pattern left by a repeated page`);
      }
      if (d.duplicatesRemoved > 0) warn(r.org, where, `${d.duplicatesRemoved} repeated post(s) returned by the data source were removed before counting`);
      if (d.droppedNoKeyword > 0) warn(r.org, where, `${d.droppedNoKeyword} post(s) returned by the search were left out because their text has none of the keywords`);
      if (d.capHit) warn(r.org, where, `fetching stopped at its page limit inside the report period — the true count may be higher`);
      if (p.key === "liData" && d.searchFallback) warn(r.org, where, `reading the company's posts failed; the count comes from the keyword search, which can miss posts`);
      if (p.key === "twData") {
        if (d.timelineAdded > 0) warn(r.org, where, `the keyword search missed ${d.timelineAdded} post(s) that the account's own timeline contained; they are counted`);
        if (d.searchFailed) warn(r.org, where, `the keyword search failed; the count comes from the account's timeline only`);
        if (d.timelineFailed) warn(r.org, where, `the cross-check against the account's own timeline failed; the count rests on the keyword search alone`);
        if (d.postCount === 0 && d.timelineRan !== true) warn(r.org, where, `0 posts is not cross-checked against the account's timeline`);
      }
    }
  }

  // ── the page shows what the data says ──
  if (html) {
    for (const p of PLATFORMS) {
      const inPage = [...html.matchAll(p.htmlRe)].map((m) => Number(m[1])).sort((a, b) => a - b);
      const inData = [...shown[p.key]].sort((a, b) => a - b);
      check(JSON.stringify(inPage) === JSON.stringify(inData), "(all)", `${p.name} counts in the report`, `the report page shows ${p.name} counts [${inPage}] but the data holds [${inData}]`);
    }
  }

  // ── share of voice arithmetic ──
  for (const dim of ["pressShare", "llmShare", "socialShare"]) {
    const total = sum(ORGS.map((o) => data[o]?.[dim]));
    const raw = dim === "pressShare" ? "sov" : dim === "llmShare" ? "aeo" : "social";
    if (sum(ORGS.map((o) => data[o]?.[raw])) > 0) {
      check(Math.abs(total - 100) <= Math.max(0.5, ORGS.length * 0.05), "(cohort)", dim, `shares add up to ${total.toFixed(1)}%, not 100%`);
    }
  }
  for (const org of ORGS) {
    const d = data[org];
    if (!d) continue;
    check(d.score >= 0 && d.score <= 100, org, "share of voice", `overall score ${d.score} is outside 0–100`);
    const mean = (d.pressShare + d.llmShare + d.socialShare) / 3;
    check(Math.abs(mean - d.score) <= 0.2, org, "share of voice", `overall score ${d.score} is not the average of its three shares (${mean.toFixed(1)})`);
  }

  // ── executive summary numbers, re-checked on the final text ──
  try {
    const v = Sentinel.validateExecSummary(execF, data, ORGS);
    checks += v.checked || 0;
    for (const i of v.issues || []) err(i.org || "(summary)", `executive summary, finding ${i.findingIdx + 1}`, `claims ${i.claimed} ${i.metric}, but the data says ${i.actual}`);
  } catch (e) {
    warn("(summary)", "executive summary", `could not be re-checked: ${e.message}`);
  }

  return { errors, warnings, checks };
}

// The evidence pack the independent reviewer sees: figures and post excerpts, nothing else.
function buildEvidencePack({ ORGS, data, socialERResults = [], youtubeERResults = [], execF = [], actions = [], dateFrom, dateTo, subject }) {
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
  const excerpt = (text, kw) => {
    const t = String(text || "");
    const i = t.toLowerCase().indexOf(String(kw).toLowerCase());
    if (i < 0) return "";
    return (i > 90 ? "…" : "") + t.slice(Math.max(0, i - 90), i + String(kw).length + 90).replace(/\s+/g, " ") + (i + kw.length + 90 < t.length ? "…" : "");
  };
  const rawOf = (d) => [...(d?.rawPosts || []), ...(d?.rawTweets || [])];
  const platform = (d) => d && (d.failed || d.noHandle) ? {
    collected: false,
    note: d.noHandle
      ? "no handle for this platform; the report shows the cell as not applicable, not as a zero"
      : "collection FAILED; the report shows the cell as unavailable (a cross), not as a measured zero. The organisation's presence points count it as 0, so its score is a lower bound",
  } : d && {
    collected: true,
    topPostsListed: (() => { const shown = (d.topPosts || []).length, all = d.postCount || 0; return `${shown} of ${all} counted posts${shown < all ? " (only the highest-engagement posts are listed)" : " (all of them are listed)"}`; })(),
    posts: d.postCount, followers: d.followers, engagementRatePct: d.er,
    likes: d.totalLikes, comments: d.totalComments ?? d.totalReplies, shares: d.totalShares ?? d.totalRetweets, views: d.totalViews,
    removedRepeats: d.duplicatesRemoved || 0, leftOutNoKeyword: d.droppedNoKeyword || 0, stoppedAtPageLimit: !!d.capHit, foundOnlyByTimeline: d.timelineAdded || 0, timelineCrossChecked: d.timelineRan === true, failed: !!d.failed, noHandle: !!d.noHandle,
    topPosts: (d.topPosts || []).map((t) => ({ url: t.url, date: t.date, text: clip(t.snippet, 220), keywordsMatched: t.keywords_found, matchExcerpts: (t.keywords_found || []).slice(0, 3).map((k) => ({ keyword: k, excerpt: excerpt((rawOf(d).find((r) => r.url && r.url === t.url) || {}).text || (rawOf(d).find((r) => r.url && r.url === t.url) || {}).snippet || t.snippet, k) })).filter((m) => m.excerpt), likes: t.likes, comments: t.comments ?? t.replies, shares: t.shares ?? t.retweets })),
  };
  return {
    subject, reportPeriod: { from: dateFrom, to: dateTo },
    organisations: ORGS.map((org) => {
      const d = data[org] || {};
      const s = socialERResults.find((r) => r.org === org) || {};
      const y = youtubeERResults.find((r) => r.org === org) || {};
      return {
        org,
        press: { articles: d.total, authoritativePct: d.authPct, dataSpecificPct: d.dataPct },
        aiVisibilityScore: d.aeo,
        social: { presencePointsOf10: s.presenceScore, linkedin: platform(s.liData), x: platform(s.twData), instagram: platform(s.igData), youtube: y && { videos: y.videoCount ?? y.videos, subscribers: y.subscribers, avgEngagementRatePct: y.avgER } },
        shareOfVoice: { press: d.pressShare, ai: d.llmShare, social: d.socialShare, overall: d.score },
      };
    }),
    executiveSummary: (execF || []).map((f) => (typeof f === "string" ? clip(f, 600) : clip(JSON.stringify(f), 700))),
    actionCount: (actions || []).length,
  };
}

/**
 * Run both layers. Resolves to { passed, errors, warnings, checks, review, summary }.
 * Never throws for a failed audit — the caller decides; it throws only for programming errors.
 */
async function runAudit(ctx, cb = () => {}) {
  const det = checkDeterministic(ctx);
  cb(`  AUDIT · rules: ${det.checks} checks, ${det.errors.length} error(s), ${det.warnings.length} warning(s)`, det.errors.length ? "err" : "ok");
  for (const e of det.errors) cb(`    ✗ ${e.org} · ${e.where}: ${e.issue}`, "err");
  for (const w of det.warnings) cb(`    ! ${w.org} · ${w.where}: ${w.issue}`, "warn");

  const out = { passed: false, errors: [...det.errors], warnings: [...det.warnings], checks: det.checks, review: { ran: false } };
  if (det.errors.length) { out.summary = summarise(out); return out; }

  cb(`  AUDIT · Claude CLI independent review...`);
  try {
    const pack = buildEvidencePack(ctx);
    const review = await Reviewer.review(pack, { cb });
    out.review = { ran: true, verdict: review.verdict, model: review.model, findings: review.findings };
    let packLabelOnly = 0;
    for (const f of review.findings) {
      // How the evidence pack labels its own lists ("topPostsListed") is not a fact about the report; it cannot be repaired by
      // changing data and must not stop a report (26-29 Oct: "the listing label undercounts the posts shown").
      const aboutPackLabel = /topPostsListed|listing label|label undercounts|label overcounts/i.test(`${f.where || ""} ${f.issue || ""}`);
      if (aboutPackLabel && f.severity === "error") packLabelOnly++;
      const item = { postUrls: f.postUrls || [], source: "review", severity: f.severity === "error" && !aboutPackLabel ? "error" : "warning", org: f.org || "(report)", where: f.where || "", issue: `${f.issue}${f.evidence ? ` — ${f.evidence}` : ""}` };
      (item.severity === "error" ? out.errors : out.warnings).push(item);
      cb(`    ${item.severity === "error" ? "✗" : "!"} Review · ${item.org} · ${item.where}: ${item.issue}`, item.severity === "error" ? "err" : "warn");
    }
    // A "fail" whose only errors were about the pack's own labels is not a failure of the report.
    if (review.verdict === "fail" && !packLabelOnly && !out.errors.some((e) => e.source === "review")) {
      out.errors.push({ source: "review", severity: "error", org: "(report)", where: "verdict", issue: "the reviewer returned a fail verdict without listing a finding" });
    }
  } catch (e) {
    out.errors.push({ source: "review", severity: "error", org: "(audit)", where: "Claude CLI review", issue: `the independent review could not be completed: ${e.message}` });
    cb(`    ✗ review could not be completed: ${e.message}`, "err");
  }
  out.passed = out.errors.length === 0;
  out.summary = summarise(out);
  cb(`  AUDIT · ${out.passed ? "passed" : "FAILED"} — ${out.summary}`, out.passed ? "ok" : "err");
  return out;
}

function summarise(a) {
  const rv = a.review?.ran ? `independent review ${a.review.model || ""} verdict ${a.review.verdict}` : "independent review not run";
  return `${a.checks} rule checks, ${a.errors.length} error(s), ${a.warnings.length} warning(s); ${rv}`;
}

/**
 * Which audit errors can be repaired by writing the executive summary again, and which cannot.
 * An error about the summary's text can; an error about the data (a post, a count, a share) cannot be
 * repaired by editing text, so any of those means the report stays stopped.
 */
function repairPlan(errors, execF) {
  const aboutSummary = (e) => /executive summary/i.test(`${e.where || ""}`);
  const summaryErrs = errors.filter(aboutSummary);
  const other = errors.filter((e) => !aboutSummary(e));
  const flagged = new Set();
  (execF || []).forEach((f, i) => {
    const h = String(f.headline || "").toLowerCase();
    for (const e of summaryErrs) {
      const hay = `${e.where || ""} ${e.issue || ""}`.toLowerCase();
      const n = /finding (\d+)/i.exec(e.where || "");
      if ((h && hay.includes(h)) || (n && Number(n[1]) === i + 1)) flagged.add(i);
    }
  });
  return {
    repairable: summaryErrs.length > 0 && other.length === 0,
    feedback: summaryErrs.map((e) => `${e.where}: ${e.issue}`).join(" | ").slice(0, 1800),
    flagged: [...flagged].sort((a, b) => a - b),
    other,
  };
}

/**
 * The counted posts a reviewer error is about. The reviewer lists them (post_urls) when it can; when it only quotes the post's
 * text ("Post text: '🌱 I look forward to speaking at the 4th World Biogas…'") the post is found from the quote, and "the only
 * post behind this organisation's score" resolves to that one post. Only the organisations the error names are searched.
 */
function resolvePosts(e, socialERResults) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  const said = norm(`${e.issue || ""}`);
  const named = `${e.org || ""} ${e.where || ""}`;
  const urls = [...(e.postUrls || [])];
  for (const r of socialERResults || []) {
    if (!named.includes(r.org)) continue;
    const posts = [r.liData, r.twData, r.igData].flatMap((d) => (d && d.topPosts) || []).filter((t) => t.url);
    for (const t of posts) {
      const head = norm(t.snippet).split(" ").slice(0, 8).join(" ");
      if (head.length >= 25 && said.includes(head)) urls.push(t.url);
    }
    const counted = [r.liData, r.twData, r.igData].reduce((n, d) => n + ((d && d.postCount) || 0), 0);
    if (counted === 1 && posts.length === 1 && /\b(only|single|sole|entire|one)\b/i.test(e.issue || "")) urls.push(posts[0].url);
  }
  return [...new Set(urls)];
}

/**
 * Posts to exclude, from reviewer errors about the DATA. Only when EVERY data error is about specific counted posts (named, or
 * found from the text the error quotes — otherwise excluding some would still leave a stopped report), every one is a counted
 * post of the report, and the exclusions stay small (at most 3 per organisation and 10 in all): a report that needs more than
 * that has a data-quality problem, not a few stray posts.
 */
function exclusionPlan(errors, socialERResults, already = []) {
  const aboutSummary = (e) => /executive summary/i.test(`${e.where || ""}`);
  const dataErrs = errors.filter((e) => !aboutSummary(e));
  const resolved = dataErrs.map((e) => ({ e, urls: resolvePosts(e, socialERResults) }));
  if (!dataErrs.length || !resolved.every((x) => x.urls.length)) return { urls: [], reason: "not every data error is about specific posts" };
  const known = new Map(); // url -> org, counted posts only
  for (const r of socialERResults || []) {
    for (const d of [r.liData, r.twData, r.igData]) for (const t of (d && d.topPosts) || []) if (t.url) known.set(t.url, r.org);
  }
  const have = new Set(already);
  const urls = [], perOrg = {};
  for (const x of resolved) for (const u of x.urls) {
    if (have.has(u) || urls.includes(u)) continue;
    const org = known.get(u);
    if (!org) return { urls: [], reason: `a named post is not one of the report's counted posts: ${u}` };
    urls.push(u); perOrg[org] = (perOrg[org] || 0) + 1;
  }
  if (!urls.length) return { urls: [], reason: "the named posts are already excluded" };
  if (Object.values(perOrg).some((n) => n > 3) || urls.length + have.size > 10) return { urls: [], reason: `too many posts (${urls.length}) to exclude one by one` };
  return { urls, perOrg };
}

function failureMessage(a) {
  const lines = a.errors.slice(0, 8).map((e) => `- ${e.org} · ${e.where}: ${e.issue}`);
  return `AUDIT FAILED — the report was not stored or sent.\n${lines.join("\n")}${a.errors.length > 8 ? `\n…and ${a.errors.length - 8} more` : ""}`;
}

// The visible/auditable stamp written into the report page.
function stamp(a) {
  return `${a.passed ? "passed" : "failed"}; ${a.summary}`.replace(/"/g, "'");
}

module.exports = { checkDeterministic, buildEvidencePack, runAudit, repairPlan, exclusionPlan, failureMessage, stamp };
