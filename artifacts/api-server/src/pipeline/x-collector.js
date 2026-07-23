'use strict';
/**
 * x-collector.js — X (Twitter) AQ data via APIdirect.io
 *
 * Approach: twitter/posts search with `from:@handle (kw1 OR kw2 OR ...)`.
 * One search call per org (+ pagination) instead of paginating the full
 * user timeline and filtering locally — same pattern as fetchLinkedIn().
 *
 * Used by: apidirect-collector.js fetchTwitter() (which calls apiFetch directly).
 * This module is kept for standalone reference / future CLI use.
 */

// 21 hardcoded AQ topic columns — one per report column
const AQ_KEYWORDS = [
  'ncap',
  'policy regulations',
  'pm2.5',
  'stubble burning',
  'clean air finance',
  'vehicular pollution',
  'health impact',
  'industrial pollution',
  'heat-aqi',
  'brick kiln',
  'petrol emission',
  'diesel emission',
  'super emitter',
  'thermal power',
  'household pollution',
  'indoor pollution',
  'biomass',
  'rice residue',
  'wheat residue',
  'road dust',
  'air quality',
];

// Default X handles for tracked AQ orgs
const ORG_X_HANDLES = {
  'CEEW':                             'CEEWIndia',
  'WRI India':                        'WRIIndia',
  'CSE India':                        'CSEIndia',
  'CSTEP':                            'cstep_india',
  'Air Pollution Action Group':       'APAGIndia',
  'Chintan':                          'ChintanIndia',
  'IIT Delhi':                        'iitdelhi',
  'IIT Kanpur':                       'IITKanpur',
  'Health Effects Institute':         'healtheffects',
  'ICCT':                             'theicct',
  'EPIC India':                       'EPIC_India',
  'Climate Trends':                   'ClimateTrends_',
  'Sustainable Futures Collaborative':'SFC_India',
};

/** Build the APIdirect twitter/posts search query for a given handle */
function buildQuery(handle) {
  const kwClause = AQ_KEYWORDS
    .map(kw => kw.includes(' ') ? `"${kw}"` : kw)
    .join(' OR ');
  return `from:@${handle} (${kwClause}) -is:retweet`;
}

/** Which of the 21 keywords matched this tweet's text */
function foundKeywords(text) {
  const lower = (text || '').toLowerCase();
  return AQ_KEYWORDS.filter(kw => lower.includes(kw));
}

module.exports = { AQ_KEYWORDS, ORG_X_HANDLES, buildQuery, foundKeywords };
