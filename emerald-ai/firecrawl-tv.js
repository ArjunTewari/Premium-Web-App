"use strict";

// ── TV Channel Coverage via Firecrawl ────────────────────────────────────────

// One Firecrawl query per org across all TV domains using a short query
// (`air quality "Org Name"`). Results are post-filtered: only articles where
// at least one AQ keyword appears in title+description+snippet+summary are kept.
// Failed requests are retried up to 3 times with exponential backoff.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Hardcoded TV channel domains — extraction is scoped to these URLs only
const TV_CHANNEL_DOMAINS = {
  NDTV: "ndtv.com",
  News18: "news18.com",
  "India Today": "indiatoday.in",
  "India TV": "indiatvnews.com",
  "ABP News": "abplive.com",
};

const INCLUDE_DOMAINS = Object.values(TV_CHANNEL_DOMAINS);

// Domain → outlet name (reverse lookup)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(
    Object.entries(TV_CHANNEL_DOMAINS).map(([name, d]) => [d, name]),
  ),
  "news.abplive.com": "ABP News",
  "www.indiatvnews.com": "India TV",
};

// 51 AQ keywords — broad post-fetch filter to catch all relevant TV coverage
const AQ_KEYWORDS = [
  // 21 report topic columns
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
  // Pollutants & metrics
  "pm10",
  "aqi",
  "smog",
  "air pollution",
  "particulate matter",
  "nitrogen dioxide",
  "no2",
  "sulfur dioxide",
  "so2",
  "nox",
  "ozone pollution",
  "black carbon",
  "fly ash",
  // India-specific AQ mechanisms
  "grap",
  "caqm",
  "odd-even",
  "bs6",
  "emission norms",
  "smog tower",
  "dg set",
  "pollution hotspot",
  // Burning sources
  "paddy burning",
  "crop fire",
  "farm fire",
  "crop residue",
  "open burning",
  "garbage burning",
  "waste burning",
  "firecracker",
  // Weather-linked AQ
  "dust storm",
];

/** Convert YYYY-MM-DD → M/D/YYYY for Firecrawl's tbs param */

function toTbsDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/** Strip www. from hostname */
function rootDomain(url) {
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="40"
    height="40"
    fill="none"
    viewBox="0 0 40 40"
  >
    <path
      fill="#ebf212"
      d="m21.466 5.071.004 10.915c.001 1.725-1.834 2.83-3.358 2.024L7.17 12.223a15.1 15.1 0 0 1 3.1-3.64l8.582 7.932c.455.42 1.172-.036.985-.626L16.509 5.41a15 15 0 0 1 4.956-.338M18.496 34.925l-.005-10.86c0-1.724 1.834-2.83 3.359-2.023l10.946 5.79a15 15 0 0 1-3.116 3.626l-8.57-7.921c-.455-.42-1.172.035-.985.625l3.316 10.441a15 15 0 0 1-4.945.322M23.492 18.898 31.44 10.3a15 15 0 0 0-3.64-3.113l-5.804 10.972c-.806 1.524.3 3.359 2.024 3.358l10.905-.005a15.2 15.2 0 0 0-.324-4.958l-10.484 3.33c-.59.187-1.045-.53-.625-.985M5.07 18.54l10.872-.004c1.725 0 2.83 1.834 2.024 3.358L12.192 32.81a15 15 0 0 1-3.627-3.103l7.906-8.553c.42-.455-.036-1.172-.626-.985L5.408 23.484a15 15 0 0 1-.337-4.943"
    />
  </svg>;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True if any of the 21 AQ keywords appear in the article text */
function matchesAQ(item) {
  const text =
    `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.some((kw) => text.includes(kw));
}

/** Keywords found in an article (for downstream keyword_found field) */
function foundKeywords(item) {
  const text =
    `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter((kw) => text.includes(kw));
}

async function firecrawlSearch(query, tbs, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${globalThis._fcKey}`,
      },
      body: JSON.stringify({
        query,
        sources: ["news"],
        includeDomains: INCLUDE_DOMAINS,
        tbs,
        limit: 15,
        scrapeOptions: { formats: ["summary"] },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.text();
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? "unknown Firecrawl error");
    return json.data?.news ?? json.data?.web ?? [];
  }
  return [];
}

/** Return AQ keywords that appear in the article's combined text fields */
function matchedKeywords(item) {
  const text =
    `${item.title || ""} ${item.description || ""} ${item.snippet || ""} ${item.summary || ""}`.toLowerCase();
  return AQ_KEYWORDS.filter((kw) => text.includes(kw));
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
        cb(
          `  [firecrawl-tv] retry ${attempt}/3 (${wait / 1000}s): ${e.message}`,
          "warn",
        );
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
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
    return Object.fromEntries(ORGS.map((o) => [o, []]));
  }

  // Store key where the inner fetch helper can reach it without threading it
  // through every call; reset after the run so it doesn't leak between runs.
  globalThis._fcKey = FIRECRAWL_KEY;

  const tbs = `cdr:1,cd_min:${toTbsDate(DATE_FROM)},cd_max:${toTbsDate(DATE_TO)}`;
  const out = Object.fromEntries(ORGS.map((o) => [o, []]));

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
      const items = await firecrawlSearch(
        query,
        sharedParams,
        FIRECRAWL_KEY,
        cb,
      );
      const seen = new Set();
      let skipped = 0;

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const domain = rootDomain(item.url || "");
        const outlet =
          DOMAIN_TO_OUTLET[domain] || DOMAIN_TO_OUTLET[`www.${domain}`];
        if (!outlet) continue; // not one of our TV domains

        const kws = matchedKeywords(item);
        if (kws.length === 0) {
          skipped++;
          continue;
        } // no AQ keyword match

        out[org].push({
          title: item.title || "",
          snippet: item.snippet || item.description || "",
          source: outlet,
          url: item.url || "",
          date: item.date || "",
          keywords: kws,
          // summary used as fullText so the TV scrape step can skip re-fetching
          fullText: item.summary
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
      cb(`  [firecrawl-tv] ${org}: ${e.message}`, "warn");
    }
  }

  globalThis._fcKey = undefined;
  return out;
}

module.exports = { fetchTvCoverage, TV_CHANNEL_DOMAINS, AQ_KEYWORDS };
