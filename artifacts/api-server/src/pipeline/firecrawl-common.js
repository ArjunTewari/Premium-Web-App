"use strict";

// ── Shared helpers for the Firecrawl TV + print collectors ───────────────────
// Both collectors previously carried their own copies of the outlet matcher and
// the AQ keyword list (51 terms in TV, a 21-term subset in print — so the same
// article could count as air-quality coverage in one section and not the other).
// They also had no attribution check at all: the search query embedded the org
// name, and whatever came back was attributed to that org.
//
// That last point was the serious one. Firecrawl's news search treats a quoted
// org name as a soft relevance signal, not an exact-phrase requirement, so for
// orgs that Indian media rarely names it silently returned generic air-quality
// stories. Measured over a Feb–May 2026 sample, 18 of 51 attributed articles
// never mentioned their org — including all 16 for Health Effects Institute,
// whose "coverage" included stories on TB vaccines, pesticides and brain
// ageing. Inflated counts are worse than zeros: they look like signal.
//
// orgMentioned() below is the gate that fixes it.

// ── AQ keyword taxonomy (single source of truth for TV and print) ────────────
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

// ── Org aliases ──────────────────────────────────────────────────────────────
// Outlets rarely use an org's full configured display name. Each entry lists
// the forms an article might actually use. Short all-caps acronyms are matched
// case-sensitively (see orgMentioned) so "CSE" doesn't fire on "case" and "HEI"
// doesn't fire inside an unrelated word.
const ORG_ALIASES = {
  "Council on Energy, Environment and Water": ["CEEW", "Council on Energy"],
  "Centre for Science and Environment":       ["CSE", "Center for Science and Environment"],
  "WRI India":                                ["WRI", "World Resources Institute"],
  "CSTEP":                                    ["Center for Study of Science, Technology and Policy",
                                               "Centre for Study of Science, Technology and Policy"],
  "Air Pollution Action Group":               ["A-PAG", "APAG"],
  "Chintan Environmental Research and Action Group": ["Chintan"],
  "IIT Delhi":                                ["IIT-Delhi", "Indian Institute of Technology Delhi"],
  "IIT Kanpur":                               ["IIT-Kanpur", "Indian Institute of Technology Kanpur"],
  "Health Effects Institute":                 ["HEI", "State of Global Air"],
  "ICCT":                                     ["International Council on Clean Transportation"],
  "EPIC India":                               ["EPIC", "Energy Policy Institute at the University of Chicago"],
  "Climate Trends":                           [],
  "Sustainable Futures Collaborative":        ["SFC"],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** A short all-caps token (CEEW, HEI, SFC) must match case-sensitively. */
const isAcronym = (s) => /^[A-Z][A-Z0-9-]{1,6}$/.test(s);

// Names that are also ordinary phrases. Multi-word names are otherwise matched
// case-insensitively (outlets mangle capitalisation constantly), but for these
// that costs precision: "scientists studying long-term climate trends" would be
// counted as coverage of Climate Trends the organisation. Requiring exact
// capitalisation separates the proper noun from the common phrase.
//
// The recall cost is small for these outlets, whose headlines are Title Case
// ("Delhi Was Most Polluted City...") rather than ALL CAPS, so a genuine
// mention still reads "Climate Trends" either way.
const STRICT_CASE = new Set([
  "Climate Trends",
  "Sustainable Futures Collaborative",
  "Chintan",
]);

/**
 * True when `text` actually names the org (or one of its aliases).
 *
 * Must be run against the article's FULL text, not its summary: on a sample of
 * genuine Health Effects Institute articles the org appeared in the summary for
 * only 1 of 3, but in the scraped markdown for 3 of 3. Gating on the summary
 * would reject real coverage. Both collectors therefore request
 * formats ["summary", "markdown"] and pass the markdown in here.
 */
function orgMentioned(text, org) {
  if (!text) return false;
  for (const name of [org, ...(ORG_ALIASES[org] || [])]) {
    if (!name) continue;
    const caseSensitive = isAcronym(name) || STRICT_CASE.has(name);
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, caseSensitive ? "" : "i");
    if (re.test(text)) return true;
  }
  return false;
}

/** Every text field Firecrawl gives us for an article, concatenated. */
function articleText(item) {
  return [item.title, item.description, item.snippet, item.summary, item.markdown]
    .filter(Boolean)
    .join("\n");
}

/**
 * Best available published date for a Firecrawl search result.
 *
 * `item.date` is Firecrawl's own news-date guess and is often missing; the
 * scraped page metadata usually carries a real ISO timestamp. Checked in
 * order of trustworthiness. Returned as-is (a string) — pipeline.js's
 * parseDateStr does the parsing.
 */
function articleDate(item) {
  const m = item.metadata || {};
  // ONLY genuine publish-date fields. Deliberately NOT `modifiedTime` /
  // `m.date` / `dc.date` — for a re-crawled evergreen page those hold the
  // crawl/last-edit date (often "today"), which made the pipeline's date-window
  // filter drop every article as "in the future". When none of these are
  // present the article is treated as undated and its date is recovered from
  // the scraped body later (STEP 1c-date).
  return (
    item.date ||
    m.publishedTime ||
    m["article:published_time"] ||
    m["article:published"] ||
    m.publishedDate ||
    m.datePublished ||
    m["og:published_time"] ||
    ""
  );
}

/** Which AQ keywords appear in the article. */
function matchedKeywords(item) {
  const text = articleText(item).toLowerCase();
  return AQ_KEYWORDS.filter((kw) => text.includes(kw));
}

/**
 * Build a URL → outlet resolver that matches subdomains.
 *
 * Replaces a www.-stripping exact lookup that silently discarded every other
 * subdomain — including swachhindia.ndtv.com, NDTV's environment desk, where
 * much of its air-quality reporting lives. Matching requires a dot boundary, so
 * notndtv.com and evilndtv.com.attacker.io never match ndtv.com.
 */
function buildOutletMatcher(domainToOutlet) {
  const matchers = Object.entries(domainToOutlet).sort(([a], [b]) => b.length - a.length);
  return function outletForUrl(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
    for (const [domain, outlet] of matchers) {
      if (host === domain || host.endsWith(`.${domain}`)) return outlet;
    }
    return null;
  };
}

/**
 * Run `fn` over every item of `items` with at most `concurrency` in flight.
 * Results come back in input order. Never rejects — a failing `fn` yields
 * `{ status: "rejected", reason }` in that slot, matching Promise.allSettled,
 * so one org erroring can't abort the whole batch.
 *
 * Used by the TV + print collectors to fan the per-org Firecrawl search out
 * instead of awaiting them one at a time (16 orgs × ~30-90s serial was the
 * dominant cost of a multi-org run).
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = {
  AQ_KEYWORDS, ORG_ALIASES, orgMentioned, articleText, articleDate, matchedKeywords,
  buildOutletMatcher, mapWithConcurrency,
};
