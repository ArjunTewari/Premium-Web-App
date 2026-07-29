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
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, isAcronym(name) ? "" : "i");
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

module.exports = {
  AQ_KEYWORDS, ORG_ALIASES, orgMentioned, articleText, matchedKeywords, buildOutletMatcher,
};
