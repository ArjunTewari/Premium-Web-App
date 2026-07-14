"use strict";

// ── Print / Digital Outlet Coverage via Serper News ──────────────────────────
// Replaced Firecrawl with Serper for print outlets. TV coverage (firecrawl-tv.js)
// still uses Firecrawl.
//
// Approach:
//   • One Serper /news call per outlet per org — query: '"OrgName" air quality site:<domain>'
//   • 4 outlets × N orgs — date-scoped via Serper tbs param
//   • Local 21-keyword relevance gate (same topic columns as TV + social)
//   • Full article text fetched by pipeline step 1c (serperScrape)

const axios = require("axios");

// Hardcoded print outlet domains — extraction is scoped to these domains only
const PRINT_OUTLET_DOMAINS = {
  "Times of India":  "timesofindia.indiatimes.com",
  "Hindustan Times": "hindustantimes.com",
  "The Hindu":       "thehindu.com",
  "Indian Express":  "indianexpress.com",
};

// Domain → outlet name (reverse lookup, strips www.)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(
    Object.entries(PRINT_OUTLET_DOMAINS).map(([name, d]) => [d, name])
  ),
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

/** YYYY-MM-DD → M/D/YYYY for Serper tbs param */
function toSerperDate(iso) {
  if (!iso) return "";
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
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  return AQ_KEYWORDS.some(kw => text.includes(kw));
}

/** Which of the 21 keywords matched */
function foundKeywords(item) {
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter(kw => text.includes(kw));
}

async function serperNews(query, serperKey, dateFrom, dateTo) {
  const body = { q: query, num: 10 };
  if (dateFrom && dateTo)
    body.tbs = `cdr:1,cd_min:${toSerperDate(dateFrom)},cd_max:${toSerperDate(dateTo)}`;
  const res = await axios.post(
    "https://google.serper.dev/news",
    body,
    {
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      timeout: 30000,
    },
  );
  return res.data.news || [];
}

/**
 * Fetch print outlet coverage for all orgs via Serper News.
 *
 * @param {object}   cfg  - Pipeline config: ORGS, DATE_FROM, DATE_TO, SERPER_KEY
 * @param {function} cb   - Progress callback: cb(msg, level)
 * @returns {Promise<Record<string, object[]>>} Articles per org
 */
async function fetchPrintCoverage(cfg, cb = () => {}) {
  const { ORGS = [], DATE_FROM, DATE_TO, SERPER_KEY } = cfg;

  if (!SERPER_KEY) {
    cb("  [serper-print] SERPER_KEY not set — skipping print coverage", "warn");
    return Object.fromEntries(ORGS.map(o => [o, []]));
  }

  const out = Object.fromEntries(ORGS.map(o => [o, []]));

  for (const org of ORGS) {
    cb(`  [serper-print] ${org}: querying 4 print outlets...`);
    const seen = new Set();

    for (const [outlet, domain] of Object.entries(PRINT_OUTLET_DOMAINS)) {
      const query = `"${org}" air quality site:${domain}`;
      try {
        const items = await serperNews(query, SERPER_KEY, DATE_FROM, DATE_TO);
        for (const item of items) {
          const url = item.link || item.url || "";
          const key = url || item.title;
          if (seen.has(key)) continue;
          seen.add(key);

          if (!matchesAQ(item)) continue;

          out[org].push({
            title:          item.title   || "",
            snippet:        item.snippet || "",
            source:         outlet,
            url,
            date:           item.date    || "",
            keywords_found: foundKeywords(item),
            fullText:       "",   // filled by pipeline step 1c (serperScrape)
            snippetOnly:    false,
          });
        }
      } catch (e) {
        cb(`  [serper-print] ${org} / ${outlet}: ${e.message}`, "warn");
      }
    }

    cb(
      `  [serper-print] ${org}: ${out[org].length} article(s) across print outlets`,
      out[org].length > 0 ? "ok" : "warn",
    );
  }

  return out;
}

module.exports = { fetchPrintCoverage, PRINT_OUTLET_DOMAINS, AQ_KEYWORDS };
