"use strict";

// ── Print / Digital Outlet Coverage via Firecrawl ────────────────────────────
// Mirrors firecrawl-tv.js exactly, but scoped to the 4 major print outlets.
// Replaces Serper site: searches in STEP 1.
//
// Approach:
//   • One Firecrawl /v2/search call per org — query: '"OrgName" air quality'
//   • includeDomains hardcoded to the 4 print outlet domains
//   • Local 21-keyword relevance gate (same topic columns as TV + social)
//   • scrapeOptions.summary so articles arrive pre-extracted (no re-scrape)

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Hardcoded print outlet domains — extraction is scoped to these URLs only
const PRINT_OUTLET_DOMAINS = {
  "Times of India":   "timesofindia.indiatimes.com",
  "Hindustan Times":  "hindustantimes.com",
  "The Hindu":        "thehindu.com",
  "Indian Express":   "indianexpress.com",
};

const INCLUDE_DOMAINS = Object.values(PRINT_OUTLET_DOMAINS);

// Domain → outlet name (reverse lookup, strips www.)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(Object.entries(PRINT_OUTLET_DOMAINS).map(([name, d]) => [d, name])),
  "www.hindustantimes.com": "Hindustan Times",
  "www.thehindu.com":       "The Hindu",
  "www.indianexpress.com":  "Indian Express",
};

// 21 hardcoded AQ topic columns — one per report column, same list across all modules
const AQ_KEYWORDS = [
  "ncap",
  "policy regulations",
  "pm2.5",
  "stubble burning",
  "clean air finance",
  "vehicular pollution",
  "health impact",
  "industrial pollution",
  "heat-aqi",
  "brick kiln",
  "petrol emission",
  "diesel emission",
  "super emitter",
  "thermal power",
  "household pollution",
  "indoor pollution",
  "biomass",
  "rice residue",
  "wheat residue",
  "road dust",
  "air quality",
];

/** YYYY-MM-DD → M/D/YYYY for Firecrawl tbs param */
function toTbsDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/** Strip www. from hostname */
function rootDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

/** True if any of the 21 AQ keywords appear in the article text */
function matchesAQ(item) {
  const text = `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.some(kw => text.includes(kw));
}

/** Which of the 21 keywords matched */
function foundKeywords(item) {
  const text = `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter(kw => text.includes(kw));
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
        scrapeOptions:  { formats: ["summary"] },
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

  for (const org of ORGS) {
    const query = `"${org}" air quality`;
    cb(`  [firecrawl-print] ${org}: searching print outlets...`);

    try {
      const items = await firecrawlSearch(query, tbs, FIRECRAWL_KEY);
      const seen  = new Set();

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const domain = rootDomain(item.url || "");
        const outlet = DOMAIN_TO_OUTLET[domain] || DOMAIN_TO_OUTLET[`www.${domain}`];
        if (!outlet) continue; // not one of our print domains

        if (!matchesAQ(item)) continue; // 21-keyword relevance gate

        out[org].push({
          title:          item.title   || "",
          snippet:        item.snippet || item.description || "",
          source:         outlet,
          url:            item.url     || "",
          date:           item.date    || "",
          keywords_found: foundKeywords(item),
          fullText:       item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-print] ${org}: ${out[org].length} print article(s) matched`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-print] ${org}: ${e.message}`, "warn");
    }
  }

  return out;
}

module.exports = { fetchPrintCoverage, PRINT_OUTLET_DOMAINS, AQ_KEYWORDS };
