"use strict";

// ── TV Channel Coverage via Firecrawl ────────────────────────────────────────
// Replaces the per-channel Serper site: searches in STEP 1b.
// One Firecrawl query per org across all TV domains; results are mapped back
// to canonical outlet names and pushed into arts[org] by pipeline.js.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";

// Outlet name → domain (drives includeDomains + reverse lookup)
const TV_CHANNEL_DOMAINS = {
  "NDTV":       "ndtv.com",
  "News18":     "news18.com",
  "India Today":"indiatoday.in",
  "Aaj Tak":    "aajtak.in",
  "India TV":   "indiatvnews.com",
  "ABP News":   "abplive.com",
};

// Domain → outlet name (built from the map above + subdomain aliases)
const DOMAIN_TO_OUTLET = {
  ...Object.fromEntries(Object.entries(TV_CHANNEL_DOMAINS).map(([name, d]) => [d, name])),
  "news.abplive.com": "ABP News",
  "www.indiatvnews.com": "India TV",
};

// 51 hardcoded AQ keywords — exact terms from the platform taxonomy
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

const KW_OR = AQ_KEYWORDS.join(" OR ");

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

  for (const org of ORGS) {
    const query = `"${org}" (${KW_OR})`;
    cb(`  [firecrawl-tv] ${org}: querying TV channels...`);

    try {
      const res = await fetch(FIRECRAWL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FIRECRAWL_KEY}`,
        },
        body: JSON.stringify({
          query,
          sources: ["news"],
          includeDomains,
          tbs,
          limit: 15,
          scrapeOptions: { formats: ["summary"] },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const err = await res.text();
        cb(`  [firecrawl-tv] HTTP ${res.status} for "${org}": ${err}`, "warn");
        continue;
      }

      const json = await res.json();
      if (!json.success) {
        cb(`  [firecrawl-tv] API error for "${org}": ${json.error ?? "unknown"}`, "warn");
        continue;
      }

      const items = json.data?.news ?? json.data?.web ?? [];
      const seen = new Set();

      for (const item of items) {
        const key = item.url || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        const domain = rootDomain(item.url || "");
        const outlet = DOMAIN_TO_OUTLET[domain];
        if (!outlet) continue; // not one of our TV domains

        out[org].push({
          title:    item.title    || "",
          snippet:  item.snippet  || item.description || "",
          source:   outlet,
          url:      item.url      || "",
          date:     item.date     || "",
          // summary used as fullText so the TV scrape step can skip re-fetching
          fullText: item.summary
            ? item.summary
            : `TITLE: ${item.title}\nSNIPPET: ${item.snippet || item.description || ""}`,
          snippetOnly: !item.summary,
        });
      }

      cb(
        `  [firecrawl-tv] ${org}: ${out[org].length} TV article(s)`,
        out[org].length > 0 ? "ok" : "warn",
      );
    } catch (e) {
      cb(`  [firecrawl-tv] Error for "${org}": ${e.message}`, "warn");
    }
  }

  return out;
}

module.exports = { fetchTvCoverage, TV_CHANNEL_DOMAINS, AQ_KEYWORDS };
