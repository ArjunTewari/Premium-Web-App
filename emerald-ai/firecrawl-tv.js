"use strict";

// ── TV Channel Coverage via Firecrawl ────────────────────────────────────────
// Approach mirrors fetch-air-quality-articles.ts:
//   • One Firecrawl /v2/search call per org with a simple query
//   • includeDomains hardcoded to the 6 TV channel domains
//   • Local keyword filter using the same 21 hardcoded AQ topic columns
//   • scrapeOptions.summary so articles arrive pre-extracted

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Hardcoded TV channel domains — extraction is scoped to these URLs only
const TV_CHANNEL_DOMAINS = {
  "NDTV":        "ndtv.com",
  "News18":      "news18.com",
  "India Today": "indiatoday.in",
  "Aaj Tak":     "aajtak.in",
  "India TV":    "indiatvnews.com",
  "ABP News":    "abplive.com",
};

const INCLUDE_DOMAINS = Object.values(TV_CHANNEL_DOMAINS);

// Domain → outlet name (reverse lookup)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(Object.entries(TV_CHANNEL_DOMAINS).map(([name, d]) => [d, name])),
  "news.abplive.com":    "ABP News",
  "www.indiatvnews.com": "India TV",
};

// 21 hardcoded AQ topic columns — same list used by LinkedIn + Instagram
const AQ_KEYWORDS = [
  "ncap",
  "policy regulations",
  "pm2.5",
  "exposure mapping",
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

/** Keywords found in an article (for downstream keyword_found field) */
function foundKeywords(item) {
  const text = `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter(kw => text.includes(kw));
}

async function firecrawlSearch(query, tbs, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${globalThis._fcKey}` },
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
 * Fetch TV channel coverage for all orgs via Firecrawl.
 *
 * @param {object}   cfg  - Pipeline config: ORGS, DATE_FROM, DATE_TO, FIRECRAWL_KEY
 * @param {function} cb   - Progress callback: cb(msg, level)
 * @returns {Promise<Record<string, object[]>>}
 */
async function fetchTvCoverage(cfg, cb = () => {}) {
  const { ORGS = [], DATE_FROM, DATE_TO, FIRECRAWL_KEY } = cfg;

  if (!FIRECRAWL_KEY) {
    cb("  [firecrawl-tv] FIRECRAWL_KEY not set — skipping TV coverage", "warn");
    return Object.fromEntries(ORGS.map(o => [o, []]));
  }

  // Store key where the inner fetch helper can reach it without threading it
  // through every call; reset after the run so it doesn't leak between runs.
  globalThis._fcKey = FIRECRAWL_KEY;

  const tbs = `cdr:1,cd_min:${toTbsDate(DATE_FROM)},cd_max:${toTbsDate(DATE_TO)}`;
  const out  = Object.fromEntries(ORGS.map(o => [o, []]));

  for (const org of ORGS) {
    // Simple query matching the fetch-air-quality-articles.ts pattern:
    // "OrgName" + "air quality" — broad enough to surface relevant stories,
    // narrow enough to avoid unrelated noise. Local keyword filter below
    // enforces the 21-column taxonomy.
    const query = `"${org}" air quality`;
    cb(`  [firecrawl-tv] ${org}: searching TV channels...`);

    try {
      const items = await firecrawlSearch(query, tbs);
      const seen  = new Set();

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const domain = rootDomain(item.url || "");
        const outlet = DOMAIN_TO_OUTLET[domain] || DOMAIN_TO_OUTLET[`www.${domain}`];
        if (!outlet) continue; // not one of our TV domains

        if (!matchesAQ(item)) continue; // local 21-keyword relevance gate

        out[org].push({
          title:         item.title   || "",
          snippet:       item.snippet || item.description || "",
          source:        outlet,
          url:           item.url     || "",
          date:          item.date    || "",
          keywords_found: foundKeywords(item),
          // summary pre-extracted by Firecrawl — skip re-scraping in STEP 1b
          fullText:      item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-tv] ${org}: ${out[org].length} TV article(s) matched`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-tv] ${org}: ${e.message}`, "warn");
    }
  }

  globalThis._fcKey = undefined;
  return out;
}

module.exports = { fetchTvCoverage, TV_CHANNEL_DOMAINS, AQ_KEYWORDS };
