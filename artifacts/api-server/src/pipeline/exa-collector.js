"use strict";

/**
 * exa-collector.js — corpus-first AQ article discovery via the Exa /search API.
 *
 * The Firecrawl / Serper collectors search per org ("OrgName air quality"),
 * which is expensive, returns loosely-related junk, and — worst — has no
 * reliable published date, so the report leaked out-of-window articles.
 *
 * This collector inverts it: fetch the whole air-quality corpus for the report
 * window from the fixed outlet list (no org name in the query), with Exa's
 * server-side `startPublishedDate` / `endPublishedDate` doing the date filtering
 * on real publish dates. pipeline.js then reads each article body and assigns it
 * to whichever tracked orgs it names; articles that name none become the
 * white-space set for Emerging Narratives.
 *
 * Needs EXA_API_KEY. Docs: https://docs.exa.ai/reference/search
 */

const axios = require("axios");
const { costTracker } = require("./claude-client");
const { AQ_KEYWORDS, buildOutletMatcher } = require("./firecrawl-common");

const EXA_ENDPOINT = "https://api.exa.ai/search";

// The fixed outlet set — print + TV. Domain → display name.
const OUTLET_DOMAINS = {
  "timesofindia.indiatimes.com": "Times of India",
  "hindustantimes.com": "Hindustan Times",
  "thehindu.com": "The Hindu",
  "indianexpress.com": "Indian Express",
  "deccanherald.com": "Deccan Herald",
  "ndtv.com": "NDTV",
  "news18.com": "News18",
  "indiatoday.in": "India Today",
  "indiatvnews.com": "India TV",
  "abplive.com": "ABP News",
};
const INCLUDE_DOMAINS = Object.keys(OUTLET_DOMAINS);
const outletForUrl = buildOutletMatcher(OUTLET_DOMAINS);

// Group the 21 AQ keywords into a handful of semantically coherent queries.
// Each query is a natural-language description (Exa's neural search wants a
// described page, not a keyword bag) that still names the concrete terms.
const KEYWORD_CLUSTERS = [
  "India air quality, AQI, PM2.5 and PM10 pollution levels, NCAP national clean air programme and clean-air policy in Delhi and other cities",
  "stubble burning, paddy and wheat crop residue, farm fires in Punjab and Haryana, and winter smog over Delhi-NCR",
  "thermal power plant and coal SO2 emissions, industrial pollution, brick kilns, vehicular and diesel/petrol exhaust emissions in India",
  "air pollution health impact, household and indoor air pollution, biomass burning, road dust and clean air finance in India",
];

async function exaSearch(query, params) {
  const body = {
    query,
    type: "auto",
    numResults: params.numResults ?? 40,
    includeDomains: INCLUDE_DOMAINS,
    startPublishedDate: params.startPublishedDate,
    endPublishedDate: params.endPublishedDate,
    contents: { text: { maxCharacters: 12000 } },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.post(EXA_ENDPOINT, body, {
        headers: { "x-api-key": params.apiKey, "Content-Type": "application/json" },
        timeout: 60000,
      });
      costTracker.exaSearches = (costTracker.exaSearches || 0) + 1;
      return data.results || [];
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 4000));
        continue;
      }
      throw new Error(`Exa ${status ?? ""}: ${e.response?.data?.error || e.message}`);
    }
  }
  return [];
}

/** YYYY-MM-DD → same (Exa wants ISO date; accepts date or datetime). */
function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(s || "") ? s.slice(0, 10) : s;
}

/**
 * Fetch the full AQ corpus for the window.
 * @returns {Promise<object[]>} [{ title, url, source, date, fullText, snippet, foundKeywords }]
 */
async function fetchCorpus(cfg, cb = () => {}) {
  const { DATE_FROM, DATE_TO, EXA_API_KEY } = cfg;
  if (!EXA_API_KEY) {
    cb("  [exa] EXA_API_KEY not set — cannot fetch corpus", "err");
    return [];
  }
  const start = isoDate(DATE_FROM);
  const end = isoDate(DATE_TO);
  cb(`  [exa] corpus fetch: ${KEYWORD_CLUSTERS.length} queries · ${start} → ${end} · ${INCLUDE_DOMAINS.length} outlets`);

  const kwLower = AQ_KEYWORDS.map((k) => k.toLowerCase());
  const seen = new Set();
  const out = [];

  const settled = await Promise.allSettled(
    KEYWORD_CLUSTERS.map((q) =>
      exaSearch(q, { apiKey: EXA_API_KEY, startPublishedDate: start, endPublishedDate: end, numResults: 40 }),
    ),
  );

  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      cb(`  [exa] query ${i + 1} failed: ${r.reason?.message || r.reason}`, "warn");
      return;
    }
    for (const it of r.value) {
      const url = it.url || "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const outlet = outletForUrl(url);
      if (!outlet) continue; // off the fixed outlet list
      const text = it.text || "";
      const hay = `${it.title || ""}\n${text}`.toLowerCase();
      const found = kwLower.filter((k) => hay.includes(k));
      if (!found.length) continue; // no AQ keyword anywhere — skip
      out.push({
        title: it.title || "",
        url,
        source: outlet,
        date: (it.publishedDate || "").slice(0, 10),
        fullText: text || `TITLE: ${it.title}`,
        snippet: (text || "").slice(0, 300),
        snippetOnly: !text,
        foundKeywords: found.slice(0, 8),
      });
    }
  });

  const undated = out.filter((a) => !a.date).length;
  cb(
    `  [exa] ${out.length} unique AQ articles in window` + (undated ? ` (${undated} without a publish date)` : ""),
    out.length ? "ok" : "warn",
  );
  return out;
}

module.exports = { fetchCorpus, OUTLET_DOMAINS };
