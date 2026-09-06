"use strict";

// ── Print / Digital Outlet Coverage via Firecrawl ────────────────────────────
// Mirrors firecrawl-tv.js exactly, but scoped to the 4 major print outlets.
// Replaces Serper site: searches in STEP 1.
//
// Approach:
//   • One Firecrawl /v2/search call per org — query: '"OrgName" air quality'
//   • includeDomains hardcoded to the 4 print outlet domains
//   • Attribution gate — the org (or an alias) must actually be named
//   • AQ relevance gate — now the SAME 51-term taxonomy firecrawl-tv.js uses
//   • scrapeOptions summary+markdown so articles arrive pre-extracted
//
// The keyword list used to be a 21-term subset that omitted "air pollution",
// "aqi", "smog" and "pm10", so a headline like "Delhi air pollution worsens as
// AQI crosses 400" passed the TV gate and was rejected here — the two sections
// disagreed on what counted as air-quality coverage. Both now share one list,
// and matched keywords are recorded on each article as `foundKeywords` (the
// field the report renderer reads) so print rows show keyword pills like TV.

const {
  AQ_KEYWORDS, orgMentioned, articleText, articleDate, matchedKeywords, buildOutletMatcher, mapWithConcurrency,
} = require("./firecrawl-common");
const { costTracker } = require("./claude-client");

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// How many per-org Firecrawl searches to run at once. Firecrawl's Standard
// plan allows well above this for /search; 5 keeps us clear of the limit while
// cutting a 16-org fetch from ~16 serial calls to ~4 waves. Override per deploy.
const FIRECRAWL_CONCURRENCY = Math.max(1, parseInt(process.env.FIRECRAWL_CONCURRENCY || "5", 10) || 5);

// Serve a cached scrape when Firecrawl already fetched the page this recently.
// Report windows are weeks in the past, so a 2-day cache is safe and makes
// re-runs (and near-duplicate org sets) far faster and cheaper. 0 disables.
const FIRECRAWL_MAX_AGE_MS = Math.max(0, parseInt(process.env.FIRECRAWL_MAX_AGE_MS || String(2 * 24 * 60 * 60 * 1000), 10) || 0);

// Hardcoded print outlet domains — extraction is scoped to these URLs only
const PRINT_OUTLET_DOMAINS = {
  "Times of India":   "timesofindia.indiatimes.com",
  "Hindustan Times":  "hindustantimes.com",
  "The Hindu":        "thehindu.com",
  "Indian Express":   "indianexpress.com",
};

const INCLUDE_DOMAINS = Object.values(PRINT_OUTLET_DOMAINS);

// Domain → outlet name. Subdomains handled by the shared suffix matcher, so the
// old per-host www. aliases are no longer needed.
const DOMAIN_TO_OUTLET = Object.fromEntries(
  Object.entries(PRINT_OUTLET_DOMAINS).map(([name, d]) => [d, name]),
);

const outletForUrl = buildOutletMatcher(DOMAIN_TO_OUTLET);

/** YYYY-MM-DD → M/D/YYYY for Firecrawl tbs param */
function toTbsDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/** Which AQ keywords matched (shared 51-term taxonomy) */
function foundKeywords(item) {
  return matchedKeywords(item);
}

async function firecrawlSearch(query, tbs, apiKey, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        sources:        ["news"],
        includeDomains: INCLUDE_DOMAINS,
        tbs,
        limit:          15,
        // markdown is required for the attribution gate — see firecrawl-tv.js.
        scrapeOptions:  {
          formats: ["summary", "markdown"],
          ...(FIRECRAWL_MAX_AGE_MS > 0 ? { maxAge: FIRECRAWL_MAX_AGE_MS } : {}),
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.text();
      if (attempt < retries) { await new Promise(r => setTimeout(r, (attempt + 1) * 3000)); continue; }
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? "unknown Firecrawl error");
    costTracker.firecrawlSearches++;
    return json.data?.news ?? json.data?.web ?? [];
  }
  return [];
}

/**
 * Fetch print outlet coverage for all orgs via Firecrawl.
 *
 * @param {object}   cfg  - Pipeline config: ORGS, DATE_FROM, DATE_TO, FIRECRAWL_KEY
 * @param {function} cb   - Progress callback: cb(msg, level)
 * @returns {Promise<Record<string, object[]>>} Articles per org
 */
async function fetchPrintCoverage(cfg, cb = () => {}) {
  const { ORGS = [], DATE_FROM, DATE_TO, FIRECRAWL_KEY } = cfg;

  if (!FIRECRAWL_KEY) {
    cb("  [firecrawl-print] FIRECRAWL_KEY not set — skipping print coverage", "warn");
    return Object.fromEntries(ORGS.map(o => [o, []]));
  }

  const tbs = `cdr:1,cd_min:${toTbsDate(DATE_FROM)},cd_max:${toTbsDate(DATE_TO)}`;
  const out  = Object.fromEntries(ORGS.map(o => [o, []]));

  cb(`  [firecrawl-print] searching ${ORGS.length} org(s), ${FIRECRAWL_CONCURRENCY} at a time...`);
  await mapWithConcurrency(ORGS, FIRECRAWL_CONCURRENCY, async (org) => {
    const query = `"${org}" air quality`;
    cb(`  [firecrawl-print] ${org}: searching print outlets...`);

    try {
      const items = await firecrawlSearch(query, tbs, FIRECRAWL_KEY);
      const seen  = new Set();
      let skipped = 0;
      let offNetwork = 0;
      let unattributed = 0;

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const outlet = outletForUrl(item.url || "");
        if (!outlet) { offNetwork++; continue; } // not one of our print domains

        // Gate 1 — attribution: the org must actually be named in the article.
        if (!orgMentioned(articleText(item), org)) { unattributed++; continue; }

        // Gate 2 — AQ relevance (shared taxonomy).
        const kws = foundKeywords(item);
        if (kws.length === 0) { skipped++; continue; }

        out[org].push({
          title:          item.title   || "",
          snippet:        item.snippet || item.description || "",
          source:         outlet,
          url:            item.url     || "",
          date:           articleDate(item),
          // Canonical field name — previously `keywords_found`, which nothing
          // downstream read, so print rows rendered without keyword pills.
          foundKeywords:  kws.slice(0, 8),
          fullText:       item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-print] ${org}: ${out[org].length} kept of ${items.length} returned ` +
          `(${unattributed} never mentioned the org, ${skipped} failed the AQ keyword gate, ` +
          `${offNetwork} off-network)`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-print] ${org}: ${e.message}`, "warn");
    }
  });

  return out;
}

module.exports = { fetchPrintCoverage, PRINT_OUTLET_DOMAINS, AQ_KEYWORDS };
