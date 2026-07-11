"use strict";

// ── TV Channel Coverage via Firecrawl ────────────────────────────────────────
// One Firecrawl query per org across all TV domains using a short query
// (`air quality "Org Name"`). Results are post-filtered: only articles where
// at least one AQ keyword appears in title+description+snippet+summary are kept.
// Failed requests are retried up to 3 times with exponential backoff.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Outlet name → domain (drives includeDomains + reverse lookup)
const TV_CHANNEL_DOMAINS = {
  "NDTV":        "ndtv.com",
  "News18":      "news18.com",
  "India Today": "indiatoday.in",
  "India TV":    "indiatvnews.com",
  "ABP News":    "abplive.com",
};

// Domain → outlet name (built from the map above + subdomain aliases)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(Object.entries(TV_CHANNEL_DOMAINS).map(([name, d]) => [d, name])),
  "news.abplive.com":    "ABP News",
  "www.indiatvnews.com": "India TV",
};

// 51 hardcoded AQ keywords — used as a post-fetch filter, NOT in the query string
const AQ_KEYWORDS = [
  // Original taxonomy
  "ncap", "pm2.5", "exposure mapping", "stubble burn", "clean air finance",
  "vehicular pollution", "health impact", "industrial pollution", "heat-aqi",
  "brick kiln", "petrol emission", "diesel emission", "super emitter",
  "thermal power", "household pollution", "indoor pollution", "biomass",
  "rice residue", "wheat residue", "road dust", "air quality",
  // Pollutants & metrics
  "pm10", "aqi", "smog", "air pollution", "particulate matter",
  "nitrogen dioxide", "no2", "sulfur dioxide", "so2", "nox",
  "ozone pollution", "black carbon", "fly ash",
  // India-specific AQ mechanisms
  "grap", "caqm", "odd-even", "bs6", "emission norms",
  "smog tower", "dg set", "pollution hotspot",
  // Burning sources
  "paddy burning", "crop fire", "farm fire", "crop residue",
  "open burning", "garbage burning", "waste burning", "firecracker",
  // Weather-linked AQ
  "dust storm",
];

/** Convert YYYY-MM-DD → M/D/YYYY for Firecrawl's tbs param */
function toTbsDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/** Extract root domain from a URL, stripping www. prefix */
function rootDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Return AQ keywords that appear in the article's combined text fields */
function matchedKeywords(item) {
  const text = `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter(kw => text.includes(kw));
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
    scrapeOptions: { formats: ["summary"] },
  };

  for (const org of ORGS) {
    const query = `air quality "${org}"`;
    cb(`  [firecrawl-tv] ${org}: querying TV channels...`);

    try {
      const items = await firecrawlSearch(query, sharedParams, FIRECRAWL_KEY, cb);
      const seen = new Set();
      let skipped = 0;

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const domain = rootDomain(item.url || "");
        const outlet = DOMAIN_TO_OUTLET[domain];
        if (!outlet) continue; // not one of our TV domains

        const kws = matchedKeywords(item);
        if (kws.length === 0) { skipped++; continue; } // no AQ keyword match

        out[org].push({
          title:      item.title    || "",
          snippet:    item.snippet  || item.description || "",
          source:     outlet,
          url:        item.url      || "",
          date:       item.date     || "",
          keywords:   kws,
          // summary used as fullText so the TV scrape step can skip re-fetching
          fullText:   item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-tv] ${org}: ${out[org].length} kept (${skipped} filtered out)`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-tv] Error for "${org}": ${e.message}`, "warn");
    }
  }

  return out;
}

module.exports = { fetchTvCoverage, TV_CHANNEL_DOMAINS, AQ_KEYWORDS };
