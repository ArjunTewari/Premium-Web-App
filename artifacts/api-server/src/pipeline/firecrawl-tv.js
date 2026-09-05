"use strict";

// ── TV Channel Coverage via Firecrawl ────────────────────────────────────────
// One Firecrawl query per org across all TV domains using a short query
// (`air quality "Org Name"`). Each result must then pass TWO gates:
//   1. attribution — the org (or an alias) is actually named in the article
//   2. relevance   — at least one AQ keyword appears
// Gate 1 is new. The query's quoted org name is only a soft relevance signal to
// Firecrawl, not an exact-phrase requirement, so results routinely came back
// with no mention of the org at all and were attributed to it anyway. See
// firecrawl-common.js for the measured false-positive rate.
// Failed requests are retried up to 3 times with exponential backoff.

const {
  AQ_KEYWORDS, orgMentioned, articleText, matchedKeywords, buildOutletMatcher, mapWithConcurrency,
} = require("./firecrawl-common");

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Per-org Firecrawl searches to run concurrently (see firecrawl-print.js).
const FIRECRAWL_CONCURRENCY = Math.max(1, parseInt(process.env.FIRECRAWL_CONCURRENCY || "5", 10) || 5);

// Cache window for Firecrawl page scrapes — report windows are historical, so a
// 2-day cache is safe and makes re-runs much faster/cheaper. 0 disables.
const FIRECRAWL_MAX_AGE_MS = Math.max(0, parseInt(process.env.FIRECRAWL_MAX_AGE_MS || String(2 * 24 * 60 * 60 * 1000), 10) || 0);

// Outlet name → domain (drives includeDomains + reverse lookup)
const TV_CHANNEL_DOMAINS = {
  "NDTV":        "ndtv.com",
  "News18":      "news18.com",
  "India Today": "indiatoday.in",
  "India TV":    "indiatvnews.com",
  "ABP News":    "abplive.com",
};

// Domain → outlet name. Subdomains are handled by outletForUrl()'s suffix
// match, so no per-subdomain aliases are needed (the old map listed
// news.abplive.com and www.indiatvnews.com explicitly and still missed
// everything else).
const DOMAIN_TO_OUTLET = Object.fromEntries(
  Object.entries(TV_CHANNEL_DOMAINS).map(([name, d]) => [d, name]),
);

// Subdomain-aware resolver (shared with firecrawl-print.js).
const outletForUrl = buildOutletMatcher(DOMAIN_TO_OUTLET);

/** Convert YYYY-MM-DD → M/D/YYYY for Firecrawl's tbs param */
function toTbsDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/**
 * Fetch a single Firecrawl search with up to 3 retries (5s, 10s backoff).
 */
async function firecrawlSearch(query, params, apiKey, cb) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(FIRECRAWL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, ...params }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
      }

      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "unknown error");
      if (json.warning) cb(`  [firecrawl-tv] warning: ${json.warning}`, "warn");

      return json.data?.news ?? json.data?.web ?? [];
    } catch (e) {
      if (attempt < 3) {
        const wait = attempt * 5_000;
        cb(`  [firecrawl-tv] retry ${attempt}/3 (${wait / 1000}s): ${e.message}`, "warn");
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

/**
 * Fetch TV channel coverage for all orgs via Firecrawl.
 *
 * @param {object} cfg  - Pipeline config: ORGS, DATE_FROM, DATE_TO, FIRECRAWL_KEY
 * @param {function} cb - Progress callback matching pipeline.js cb(msg, level)
 * @returns {Promise<Record<string, object[]>>} Articles per org, ready for arts[org]
 */
async function fetchTvCoverage(cfg, cb = () => {}) {
  const { ORGS = [], DATE_FROM, DATE_TO, FIRECRAWL_KEY } = cfg;

  if (!FIRECRAWL_KEY) {
    cb("  [firecrawl-tv] FIRECRAWL_KEY not set — skipping Firecrawl TV search", "warn");
    return Object.fromEntries(ORGS.map(o => [o, []]));
  }

  const tbs = `cdr:1,cd_min:${toTbsDate(DATE_FROM)},cd_max:${toTbsDate(DATE_TO)}`;
  const includeDomains = Object.values(TV_CHANNEL_DOMAINS);
  const out = Object.fromEntries(ORGS.map(o => [o, []]));

  const sharedParams = {
    sources: ["news"],
    includeDomains,
    tbs,
    limit: 15,
    // markdown is required for the attribution gate: on a sample of genuine
    // Health Effects Institute articles the org appeared in the summary for
    // only 1 of 3, but in the markdown for 3 of 3. Gating on summary alone
    // would drop real coverage. Both formats come back in the same request.
    scrapeOptions: {
      formats: ["summary", "markdown"],
      ...(FIRECRAWL_MAX_AGE_MS > 0 ? { maxAge: FIRECRAWL_MAX_AGE_MS } : {}),
    },
  };

  cb(`  [firecrawl-tv] querying ${ORGS.length} org(s), ${FIRECRAWL_CONCURRENCY} at a time...`);
  await mapWithConcurrency(ORGS, FIRECRAWL_CONCURRENCY, async (org) => {
    const query = `air quality "${org}"`;
    cb(`  [firecrawl-tv] ${org}: querying TV channels...`);

    try {
      const items = await firecrawlSearch(query, sharedParams, FIRECRAWL_KEY, cb);
      const seen = new Set();
      let skipped = 0;
      let offNetwork = 0;
      let unattributed = 0;

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const outlet = outletForUrl(item.url || "");
        if (!outlet) { offNetwork++; continue; }

        // Gate 1 — attribution. Firecrawl treats the quoted org name as a soft
        // relevance hint, so an article can come back without naming the org at
        // all. Counting those inflates coverage with articles the org had no
        // part in, which is worse than reporting a zero.
        if (!orgMentioned(articleText(item), org)) { unattributed++; continue; }

        // Gate 2 — AQ relevance.
        const kws = matchedKeywords(item);
        if (kws.length === 0) { skipped++; continue; }

        out[org].push({
          title:         item.title   || "",
          snippet:       item.snippet || item.description || "",
          source:        outlet,
          url:           item.url     || "",
          date:          item.date    || "",
          // Canonical field name, shared with firecrawl-print.js and read
          // directly by the report renderer.
          foundKeywords: kws.slice(0, 8),
          fullText:      item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-tv] ${org}: ${out[org].length} kept of ${items.length} returned ` +
          `(${unattributed} never mentioned the org, ${skipped} failed the AQ keyword gate, ` +
          `${offNetwork} off-network)`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-tv] Error for "${org}": ${e.message}`, "warn");
    }
  });

  return out;
}

module.exports = { fetchTvCoverage, TV_CHANNEL_DOMAINS, AQ_KEYWORDS };
