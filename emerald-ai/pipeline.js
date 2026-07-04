"use strict";
/**
 * Emerald AI — AQ Intelligence Pipeline
 * Called by index.js with a config object. Streams log lines via cb().
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const SI = require("./social-intelligence");

const OUTLETS = [
  "Times of India",
  "Hindustan Times",
  "The Hindu",
  "Indian Express",
  "Deccan Herald",
  "India Today",
  "News18",
  "NDTV",
  "Aaj Tak",
  "India TV",
  "ABP News",
];
// Key print/digital outlets shown in the outlet breakdown table
const PRINT_OUTLETS = [
  "Times of India",
  "Hindustan Times",
  "The Hindu",
  "Indian Express",
  "Deccan Herald",
];
const TV_CHANNELS_ENGLISH = ["NDTV", "News18", "India Today"];
const TV_CHANNELS_HINDI = ["Aaj Tak", "India TV", "ABP News"];
const ALL_TV_CHANNELS = [...TV_CHANNELS_ENGLISH, ...TV_CHANNELS_HINDI];
const TV_CHANNEL_DOMAINS = {
  "NDTV": "ndtv.com",
  "News18": "news18.com",
  "India Today": "indiatoday.in",
  "Aaj Tak": "aajtak.in",
  "India TV": "indiatvnews.com",
  "ABP News": "abplive.com",
};
// ── Topic taxonomy ────────────────────────────────────────────────────────
// CANONICAL AQ sub-topic list used for press article classification.
// Each entry maps to a known Indian AQ policy or pollution-source category.
//
// ⚠  DO NOT MODIFY without deliberate review. These topics are not the same
// as the LLM visibility questions — they are fixed classification labels.
// Adding a topic means Claude must find it in scraped article text.
// Removing one silently drops that coverage dimension from every report.
// Renaming breaks backward consistency across report runs.
const TOPICS = [
  "NCAP",
  "Policy",
  "PM2.5 Exposure",
  "Stubble Burning",
  "Clean Air Finance",
  "Vehicular Pollution",
  "Health Impact",
  "Industrial Pollution",
  "Heat-AQI",
  "Brick Kilns",
  "Petrol Emissions",
  "Diesel Emissions",
  "Super Emitters",
  "Thermal Power Plants",
  "Household Pollution",
  "Indoor Pollution",
  "Biomass Air Pollution",
  "Rice Residue Burning",
  "Wheat Residue Burning",
  "Road Dust",
];
// 13 visually distinct colours — one per org slot
const ORG_COLORS_HEX = [
  "3d8ef0",
  "e05c3a",
  "4caf74",
  "c9922a",
  "a371f7",
  "e05c5c",
  "14b8a6",
  "f97316",
  "8b5cf6",
  "06b6d4",
  "84cc16",
  "ef4444",
  "ec4899",
];
const orgHex = (i) => "#" + ORG_COLORS_HEX[i % ORG_COLORS_HEX.length];
const orgPptx = (i) => ORG_COLORS_HEX[i % ORG_COLORS_HEX.length];

// AQ questions asked to each LLM for AEO scoring
// Intentionally generic — no org names — so mentions in responses are fully organic
const AEO_QUESTIONS = [
  "What does the latest research say about PM2.5 health impacts in Indian cities?",
  "How effective has India's National Clean Air Programme been so far, and what does the evidence show?",
  "What are the main sources of air pollution in Indian cities and what data exists on their relative contribution?",
  "What are the most trusted data sources for monitoring air quality across Indian cities?",
  "What scientific evidence exists on the health burden of air pollution in India?",
  "What policy interventions have been most effective at reducing air pollution in Indian cities?",
  "How is coal-based power generation contributing to air quality problems in India?",
  "What is known about seasonal air quality patterns in North India — what drives the winter smog?",
  "How do Indian cities compare on air quality improvement, and which approaches are working best?",
  "What are the key gaps in India's air quality monitoring and reporting infrastructure?",
  "What role do Indian think tanks and research organisations play in shaping clean air policy?",
  "Which organisations are most active in advocating for stricter air quality standards in India?",
  "What is the current scientific consensus on crop residue burning and its contribution to North India AQ?",
  "How is India's electric vehicle transition contributing to improvements in urban air quality?",
  "What are the most significant emerging air pollution sources in Indian cities that need attention?",
];

// ── Utilities ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const dom = (url) => {
  try {
    return new URL(url).hostname.replace("www.", "").split(".")[0];
  } catch {
    return "";
  }
};

function extractJsonArray(raw) {
  if (!raw) return null;
  const s = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = s.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseJ(raw) {
  if (!raw) return null;
  let s = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const si = s.search(/[\[{]/);
  if (si > 0) s = s.slice(si);
  const ei = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (ei > 0) s = s.slice(0, ei + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseDateStr(s) {
  if (!s) return null;
  const now = new Date();
  const ago = s.match(/(\d+)\s*(day|week|month|year)/i);
  if (ago) {
    const n = parseInt(ago[1]),
      u = ago[2][0].toLowerCase(),
      d = new Date(now);
    if (u === "d") d.setDate(d.getDate() - n);
    else if (u === "w") d.setDate(d.getDate() - n * 7);
    else if (u === "m") d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const mo = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const m1 = s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m1) {
    const mv = mo[m1[1].toLowerCase().slice(0, 3)];
    if (mv != null) return new Date(parseInt(m1[3]), mv, parseInt(m1[2]));
  }
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso)
    return new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
  return null;
}

// ── Classification helpers ─────────────────────────────────────────────────
/** Count exact-phrase occurrences of org name (case-insensitive) in scraped text */
function countMentions(text, org) {
  if (!text || !org) return 0;
  const escaped = org.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.toLowerCase().match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

/** Citation verification model — lighter/cheaper than the classification model */
const CITATION_HAIKU_MODEL = "claude-haiku-4-5";

/** Extract the ±N lines surrounding every mention of `term` in the text, so the
 *  citation verifier sees the actual context around the org mention rather than
 *  an arbitrary first-N-chars slice. Falls back to a head slice if no line matches. */
function extractCitationContext(fullText, term, linesAround = 2, maxChars = 1400) {
  if (!fullText) return "";
  const lines = fullText.split("\n");
  const termLower = (term || "").toLowerCase();
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!termLower || !lines[i].toLowerCase().includes(termLower)) continue;
    const start = Math.max(0, i - linesAround);
    const end = Math.min(lines.length - 1, i + linesAround);
    for (let k = start; k <= end; k++) keep.add(k);
  }
  if (!keep.size) return fullText.slice(0, maxChars);
  const ctx = [...keep].sort((a, b) => a - b).map(k => lines[k]).join("\n").trim();
  return ctx.slice(0, maxChars);
}

/** Return a ~windowSize window of text centered on the first occurrence of org.
 *  If org is not found, returns first windowSize chars (caller should check countMentions). */
function extractRelevantWindow(text, org, windowSize = 700) {
  if (!text) return "";
  const escaped = org.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idx = text.toLowerCase().search(new RegExp(escaped));
  if (idx === -1) return text.slice(0, windowSize);
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, idx - half);
  let end = Math.min(text.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  return (
    (start > 0 ? "..." : "") +
    text.slice(start, end) +
    (end < text.length ? "..." : "")
  );
}

// Auto-generate a 3+ letter abbreviation from multi-word org names.
// Returns null for short/single-word orgs that are already acronyms.
const ABBR_STOP = new Set(['of','on','and','the','for','in','at','by','to','a','an','with','its','vs']);
function getAbbreviation(orgName) {
  const words = orgName.replace(/[^a-zA-Z\s]/g, ' ').trim().split(/\s+/)
    .filter(w => w.length > 1 && !ABBR_STOP.has(w.toLowerCase()));
  if (words.length < 2) return null;
  const abbr = words.map(w => w[0].toUpperCase()).join('');
  if (abbr.length < 3) return null;
  if (orgName.replace(/[^a-zA-Z]/g, '').length <= 6) return null; // already short/acronym
  return abbr;
}

// Word-boundary mention count for abbreviations (prevents "HEI" matching inside "their")
function countAbbrMentions(text, abbr) {
  if (!text || !abbr) return 0;
  const esc = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${esc}\\b`, 'g')) || []).length;
}

function canonOutlet(src) {
  if (!src) return null;
  const s = src.toLowerCase();
  if (
    s.includes("times of india") ||
    s.includes("timesofindia") ||
    s.includes("indiatimes")
  )
    return "Times of India";
  if (s.includes("hindustan times") || s.includes("hindustantimes"))
    return "Hindustan Times";
  if (s.includes("the hindu") || s.includes("thehindu")) return "The Hindu";
  if (s.includes("indian express") || s.includes("indianexpress")) return "Indian Express";
  if (s.includes("deccan herald") || s.includes("deccanherald")) return "Deccan Herald";
  if (s.includes("india today") || s.includes("indiatoday"))
    return "India Today";
  if (s.includes("ndtv")) return "NDTV";
  if (s.includes("news18")) return "News18";
  if (s.includes("aaj tak") || s.includes("aajtak")) return "Aaj Tak";
  if (s.includes("india tv") || s.includes("indiatv")) return "India TV";
  if (s.includes("abp news") || s.includes("abplive")) return "ABP News";
  return null;
}

// ── API calls ──────────────────────────────────────────────────────────────
function toSerperDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  return `${m}/${d}/${y}`;
}

async function serperSearch(query, key, dateFrom, dateTo) {
  const body = { q: query, num: 10 };
  if (dateFrom && dateTo)
    body.tbs = `cdr:1,cd_min:${toSerperDate(dateFrom)},cd_max:${toSerperDate(dateTo)}`;
  try {
    const res = await axios.post(
      "https://google.serper.dev/news",
      body,
      {
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    costTracker.serperQueries++;
    return res.data.news || res.data.organic || [];
  } catch (e) {
    const detail = e.response?.data?.message || e.response?.data?.error || e.message;
    throw new Error(`Serper ${e.response?.status ?? ''}: ${detail}`);
  }
}

async function serperScrape(url, key) {
  try {
    const res = await axios.post(
      "https://scrape.serper.dev",
      { url },
      {
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    costTracker.serperQueries++;
    // Collapse spaces/tabs but PRESERVE newlines so downstream line-window logic
    // (extractCitationContext ±N lines) can locate context around mentions.
    return (res.data.text || res.data.content || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_CLASSIFY_MODEL = "claude-sonnet-4-6";

async function callClaude(prompt, key, maxTokens = 2500, model = CLAUDE_MODEL) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 90000,
    },
  );
  const usage = res.data.usage;
  if (usage) {
    costTracker.claudeInputTokens += usage.input_tokens || 0;
    costTracker.claudeOutputTokens += usage.output_tokens || 0;
  }
  return res.data.content[0].text;
}

// ── AEO: handled via SI.runAEO (social-intelligence.js)
// ── Social Media: Twitter/X ────────────────────────────────────────────────
async function fetchTwitter(cfg, orgs, cb) {
  const results = {};
  for (const org of orgs)
    results[org] = { tweetCount: 0, topTweet: null, error: null };

  if (!cfg.TWITTER_KEY) return results;

  // Run all orgs in parallel — Promise.allSettled handles individual failures gracefully
  cb(
    `  Querying Twitter/X for ${orgs.length} orgs in parallel (rate-limited to 1 rps)...`,
  );
  // Stagger requests by 1 second each to respect Twitter free-tier rate limit
  await Promise.allSettled(
    orgs.map((org, i) =>
      sleep(i * 1100).then(() =>
        axios
          .get("https://api.twitter.com/2/tweets/search/recent", {
            params: {
              query: `"${org}" air quality India -is:retweet lang:en`,
              max_results: 10,
              "tweet.fields": "public_metrics,created_at",
            },
            headers: { Authorization: `Bearer ${cfg.TWITTER_KEY}` },
            timeout: 15000,
          })
          .then((res) => {
            const tweets = res.data.data || [];
            results[org].tweetCount =
              res.data.meta?.total_count || tweets.length;
            const best = tweets.sort(
              (a, b) =>
                (b.public_metrics?.like_count || 0) +
                (b.public_metrics?.retweet_count || 0) -
                ((a.public_metrics?.like_count || 0) +
                  (a.public_metrics?.retweet_count || 0)),
            )[0];
            if (best)
              results[org].topTweet = {
                text: best.text?.slice(0, 200) || "",
                likes: best.public_metrics?.like_count || 0,
                retweets: best.public_metrics?.retweet_count || 0,
                date: best.created_at?.slice(0, 10) || "",
              };
            cb(
              `  Twitter — ${org}: ${results[org].tweetCount} tweets`,
              results[org].tweetCount > 0 ? "ok" : "warn",
            );
          })
          .catch((e) => {
            results[org].error = e.response?.data?.detail || e.message;
            cb(`  Twitter error for ${org}: ${results[org].error}`, "warn");
          }),
      ),
    ),
  );
  return results;
}

// ── Core aggregation ───────────────────────────────────────────────────────
function aggregateOrg(artList, clsList, dateFrom) {
  const oc = {};
  OUTLETS.forEach((o) => (oc[o] = 0));
  artList.forEach((a) => {
    const c = canonOutlet(a.source || "");
    if (c && oc.hasOwnProperty(c)) oc[c]++;
  });
  clsList.forEach((c) => {
    const cn = canonOutlet(c.outlet || "");
    if (cn && oc.hasOwnProperty(cn) && oc[cn] === 0) oc[cn] = 1;
  });
  const so = Object.entries(oc)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const ac = 0;
  const dc = clsList.filter((c) => c.citation_quality === "Data Cited").length;
  const tc = {};
  TOPICS.forEach((t) => (tc[t] = 0));
  clsList.forEach((c) => {
    const t = (c.aq_subtopic || "").trim();
    const match = TOPICS.find(
      (tp) =>
        tp.toLowerCase() === t.toLowerCase() ||
        t.toLowerCase().includes(tp.toLowerCase().split(" ")[0].toLowerCase()),
    );
    if (match) tc[match]++;
  });
  const sov = Math.min(100, Math.round(artList.length * 2.5));
  const authPct = clsList.length ? Math.round((ac / clsList.length) * 100) : 0;
  const dataPct = clsList.length ? Math.round((dc / clsList.length) * 100) : 0;
  return {
    total: artList.length,
    classified: clsList.length,
    authCount: ac,
    authPct,
    dataCount: dc,
    dataPct,
    outletCounts: oc,
    sortedOutlets: so,
    topOutlet: so[0]?.[0] || "N/A",
    topOutlets: so.slice(0, 3).map(([o]) => o),
    topicCounts: tc,
    authExamples: clsList
      .filter((c) => c.citation_quality === "Data Cited")
      .slice(0, 2),
    vagueExamples: clsList
      .filter((c) => c.citation_quality === "Named Mention")
      .slice(0, 2),
    classifications: clsList,
    sov,
    authPct,
    dataPct,
  };
}

function computeScore(d, aeoScore, socialScore = 0) {
  // socialScore is 0–10; multiply ×2 to keep max 20-pt contribution like before
  const tot = Math.round(
    d.sov * 0.25 + d.dataPct * 0.25 + aeoScore * 0.3 + socialScore * 2,
  );
  return {
    ...d,
    aeo: aeoScore,
    social: socialScore,
    score: tot,
    grade:
      tot >= 80
        ? "A"
        : tot >= 65
          ? "B"
          : tot >= 50
            ? "C+"
            : tot >= 35
              ? "D"
              : "F",
  };
}

// PR wire sites and org's own domain — never count as third-party coverage
const PR_WIRE_DOMAINS = [
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "newswire.com",
  "prlog.org",
  "einpresswire.com",
  "pib.gov.in",
  "prwire.in",
  "prnewswire.co.in",
  "accesswire.com",
];
const ORG_DOMAIN_HINTS = {
  ceew: ["ceew.in"],
  cstep: ["cstep.in"],
  wri: ["wri.org"],
  icct: ["theicct.org"],
  teri: ["teriin.org", "teri.res.in"],
  cse: ["cseindia.org"],
  care4air: ["care4air.org"],
  iforest: ["indiaforrenewables.org"],
};
function isThirdParty(url, orgName) {
  const u = (url || "").toLowerCase();
  if (PR_WIRE_DOMAINS.some((d) => u.includes(d))) return false;
  const orgKey = orgName.toLowerCase().replace(/[^a-z]/g, "");
  for (const [key, domains] of Object.entries(ORG_DOMAIN_HINTS)) {
    if (orgKey.includes(key) && domains.some((d) => u.includes(d)))
      return false;
  }
  const abbrev = orgKey.slice(0, Math.min(6, orgKey.length));
  if (abbrev.length >= 4) {
    try {
      if (new URL(url).hostname.includes(abbrev)) return false;
    } catch {}
  }
  return true;
}

// ── Spike detection + Claude annotation ───────────────────────────────────
async function computeSpikeAnnotations(arts, ORGS, DATE_FROM, DATE_TO, claudeKey, cb) {
  if (!claudeKey) return [];
  const start = new Date(DATE_FROM);
  const end   = new Date(DATE_TO);

  const weeks = [];
  const cur = new Date(start);
  cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
  if (cur > start) cur.setDate(cur.getDate() - 7);
  while (cur <= end) { weeks.push(new Date(cur)); cur.setDate(cur.getDate() + 7); }

  // Build article buckets per week per org
  const buckets = weeks.map(() => ORGS.map(() => []));
  ORGS.forEach((org, oi) => {
    (arts[org] || []).forEach((art) => {
      const d = parseDateStr(art.date || "");
      if (!d) return;
      for (let wi = 0; wi < weeks.length; wi++) {
        const wEnd = new Date(weeks[wi]); wEnd.setDate(wEnd.getDate() + 7);
        if (d >= weeks[wi] && d < wEnd) { buckets[wi][oi].push(art); break; }
      }
    });
  });

  // Detect spikes: week count >= max(3, 2× org average)
  const spikes = [];
  ORGS.forEach((org, oi) => {
    const counts = buckets.map((b) => b[oi].length);
    const avg = counts.reduce((s, c) => s + c, 0) / (counts.length || 1);
    const threshold = Math.max(3, avg * 2);
    counts.forEach((count, wi) => {
      if (count < threshold) return;
      const wEnd = new Date(weeks[wi]); wEnd.setDate(wEnd.getDate() + 6);
      const fmt = (d) => `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      spikes.push({ org, wi, count, wLabel: `${fmt(weeks[wi])} to ${fmt(wEnd)}`, articles: buckets[wi][oi] });
    });
  });

  if (!spikes.length) return [];

  const spikeDescs = spikes.map((s, i) => {
    const lines = s.articles.slice(0, 5).map((a) =>
      `  - "${(a.title || a.snippet || "").slice(0, 80)}" (${a.source || ""}, ${a.date || ""})`
    ).join("\n");
    return `Spike ${i+1}: ${s.org}, week ${s.wLabel}, ${s.count} articles:\n${lines}`;
  }).join("\n\n");

  try {
    const raw = await callClaude(
      `Analyse these AQ media coverage spikes. For each, write ONE punchy sentence identifying the likely trigger (report release, government event, announcement) and top outlets involved. Be factual.

${spikeDescs}

Return ONLY a JSON array: [{"idx":0,"annotation":"..."},...]`,
      claudeKey, 600
    );
    const parsed = extractJsonArray(raw);
    if (!parsed) return spikes.map((s) => ({ ...s, annotation: "" }));
    return spikes.map((s, i) => ({ ...s, annotation: parsed.find((p) => p.idx === i)?.annotation || "" }));
  } catch (e) {
    cb(`  Spike annotation skipped: ${e.message}`, "warn");
    return spikes.map((s) => ({ ...s, annotation: "" }));
  }
}

// ── Cost accumulator (reset per run) ──────────────────────────────────────
const costTracker = { serperQueries: 0, claudeInputTokens: 0, claudeOutputTokens: 0 };

// ══════════════════════════════════════════════════════════════════════════
//  MAIN PIPELINE EXPORT
// ══════════════════════════════════════════════════════════════════════════
async function run(cfg, cb) {
  // cfg: { ORGS[], DATE_FROM, DATE_TO, CLIENT_NAME, SERPER_KEY, CLAUDE_KEY, CLAUDE_MODEL,
  //         OPENAI_KEY?, PERPLEXITY_KEY?, GEMINI_KEY?, TWITTER_KEY?, YOUTUBE_KEY?, outDir }
  // cb(message, level) — streams log lines

  costTracker.serperQueries = 0;
  costTracker.claudeInputTokens = 0;
  costTracker.claudeOutputTokens = 0;

  // Simple concurrency limiter — no extra npm dep needed
  function pLimit(concurrency) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= concurrency || queue.length === 0) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(r => { active--; resolve(r); next(); }).catch(e => { active--; reject(e); next(); });
    };
    return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  }

  const { ORGS, DATE_FROM, DATE_TO, CLIENT_NAME } = cfg;

  const SCOPE_KEYWORDS = cfg.SCOPE_KEYWORDS?.length
    ? cfg.SCOPE_KEYWORDS
    : [
        "air quality",
        "AQI",
        "PM2.5",
        "PM10",
        "air pollution",
        "clean air",
        "smog",
        "Black Carbon",
        "Ozone",
        "Ammonia",
        "Carbon Monoxide",
        "Nitrogen Dioxide",
        "Methane",
        "NCAP",
        "GRAP",
      ];

  const inRange = (dateStr) => {
    const d = parseDateStr(dateStr);
    if (!d) return false; // exclude articles with no parseable date
    const f = new Date(DATE_FROM),
      t = new Date(DATE_TO);
    t.setDate(t.getDate() + 1);
    return d >= f && d <= t;
  };

  cb(`\n=== Emerald AI · AQ Intelligence Report ===`, "head");
  cb(`Orgs: ${ORGS.join(", ")} · ${DATE_FROM} to ${DATE_TO}`);

  // ── STEP 1: Fetch articles ─────────────────────────────────
  cb(`\nSTEP 1/6 — Fetching articles from Serper...`, "head");
  const arts = {};
  for (const o of ORGS) arts[o] = [];

  {
    const limit1 = pLimit(4); // 4 orgs in parallel — safe for Serper rate limits
    await Promise.allSettled(ORGS.map(org => limit1(async () => {
      const seen = new Set();
      for (const kw of SCOPE_KEYWORDS.slice(0, 8)) {
        let skipped = 0;
        const q = `"${org}" ${kw} India`;
        cb(`  ${q}`);
        try {
          const results = await serperSearch(q, cfg.SERPER_KEY, DATE_FROM, DATE_TO);
          let added = 0;
          for (const r of results) {
            const k = r.link || r.title;
            if (!seen.has(k)) {
              seen.add(k);
              if (!inRange(r.date || "")) { skipped++; continue; }
              const outlet = canonOutlet(r.source || dom(r.link || ""));
              if (outlet !== null && isThirdParty(r.link || "", org)) {
                arts[org].push({ title: r.title || "", snippet: r.snippet || "", source: outlet, url: r.link || "", date: r.date || "" });
                added++;
              }
            }
          }
          cb(`  +${added} kept, ${skipped} outside date range`, "ok");
        } catch (e) {
          cb(`  Serper error: ${e.message}`, "warn");
        }
        await sleep(300);
      }
      // Abbreviation fallback — search for e.g. "HEI" if org = "Health Effects Institute"
      const abbr = getAbbreviation(org);
      if (abbr) {
        cb(`  [abbr] searching for "${abbr}" (abbreviation of ${org})...`);
        for (const kw of SCOPE_KEYWORDS.slice(0, 5)) {
          const q = `"${abbr}" ${kw} India`;
          try {
            const results = await serperSearch(q, cfg.SERPER_KEY, DATE_FROM, DATE_TO);
            let added = 0;
            for (const r of results) {
              const k = r.link || r.title;
              if (!seen.has(k)) {
                seen.add(k);
                if (!inRange(r.date || "")) continue;
                const outlet = canonOutlet(r.source || dom(r.link || ""));
                if (outlet !== null && isThirdParty(r.link || "", org)) {
                  arts[org].push({ title: r.title || "", snippet: r.snippet || "", source: outlet, url: r.link || "", date: r.date || "", matchTerm: abbr });
                  added++;
                }
              }
            }
            if (added > 0) cb(`  +${added} via "${abbr}"`, "ok");
          } catch (e) {
            cb(`  Abbr search error: ${e.message}`, "warn");
          }
          await sleep(300);
        }
      }
      cb(`  ${org}: ${arts[org].length} articles`, "ok");
    })));
  }

  // Snapshot before TV so we know which articles are TV-only (for targeted scrape later)
  const tvStartIdx = {};
  for (const org of ORGS) tvStartIdx[org] = arts[org].length;

  // ── STEP 1b: TV channel targeted searches ──────────────────
  cb(`\nSTEP 1b/6 — Fetching TV channel coverage (site: searches)...`, "head");
  // Build a broad OR clause from the user's scope keywords (up to 6)
  const tvKws = SCOPE_KEYWORDS.slice(0, 6);
  const tvKwClause = tvKws.length === 1
    ? `"${tvKws[0]}"`
    : `(${tvKws.map((k) => `"${k}"`).join(" OR ")})`;
  {
    const limit1c = pLimit(4); // 4 orgs in parallel
    await Promise.allSettled(ORGS.map(org => limit1c(async () => {
      const tvSeen = new Set(arts[org].map((a) => a.url || a.title));
      const tvAbbr = getAbbreviation(org);
      for (const [channel, domain] of Object.entries(TV_CHANNEL_DOMAINS)) {
        const q = `site:${domain} "${org}" ${tvKwClause}`;
        cb(`  ${q}`);
        try {
          const results = await serperSearch(q, cfg.SERPER_KEY, DATE_FROM, DATE_TO);
          let added = 0;
          for (const r of results) {
            const k = r.link || r.title;
            if (!tvSeen.has(k)) {
              tvSeen.add(k);
              if (!inRange(r.date || "")) continue;
              arts[org].push({ title: r.title || "", snippet: r.snippet || "", source: channel, url: r.link || "", date: r.date || "" });
              added++;
            }
          }
          cb(`  ${channel} · ${org}: +${added}`, added > 0 ? "ok" : "warn");
        } catch (e) {
          cb(`  TV search error (${channel}): ${e.message}`, "warn");
        }
        // Abbreviation TV search
        if (tvAbbr) {
          const qAbbr = `site:${domain} "${tvAbbr}" ${tvKwClause}`;
          try {
            const results = await serperSearch(qAbbr, cfg.SERPER_KEY, DATE_FROM, DATE_TO);
            let added = 0;
            for (const r of results) {
              const k = r.link || r.title;
              if (!tvSeen.has(k)) {
                tvSeen.add(k);
                if (!inRange(r.date || "")) continue;
                arts[org].push({ title: r.title || "", snippet: r.snippet || "", source: channel, url: r.link || "", date: r.date || "", matchTerm: tvAbbr });
                added++;
              }
            }
            if (added > 0) cb(`  ${channel} · "${tvAbbr}": +${added}`, "ok");
          } catch (e) {
            cb(`  TV abbr search error (${channel}): ${e.message}`, "warn");
          }
        }
        await sleep(300);
      }
    })));
  }

  // ── STEP 1b (TV scrape): Scrape TV articles separately ─────
  // TV articles were appended after the print search so they fall beyond the
  // main 16-article scrape window. Scrape up to 8 TV articles per org here.
  {
    const tvScrapeLimit = pLimit(8);
    const tvScrapeJobs = ORGS.flatMap(org =>
      arts[org].slice(tvStartIdx[org]).filter(a => !a.fullText).slice(0, 8)
        .map((a, i) => ({ org, a, i }))
    );
    if (tvScrapeJobs.length) {
      cb(`  Scraping ${tvScrapeJobs.length} TV article(s)...`);
      await Promise.allSettled(tvScrapeJobs.map(({ org, a, i }) => tvScrapeLimit(async () => {
        if (!a.url) {
          a.fullText = `TITLE: ${a.title}\nSNIPPET: ${a.snippet || ""}`;
          a.snippetOnly = true;
          return;
        }
        const txt = await serperScrape(a.url, cfg.SERPER_KEY);
        if (txt && txt.length > 300) {
          a.fullText = txt;
          cb(`  [TV ${org} ${i + 1}] scraped ${txt.length} chars`, "ok");
        } else {
          a.fullText = `TITLE: ${a.title}\nSNIPPET: ${a.snippet || ""}`;
          a.snippetOnly = true;
          cb(`  [TV ${org} ${i + 1}] snippet fallback`, "warn");
        }
      })));
    }
  }

  // ── STEP 1c: Scrape print/news article text ─────────────────
  cb(`\nSTEP 1c/6 — Scraping full article text (print/news)...`, "head");
  {
    // Scrape up to 16 per org (matches classification cap) — concurrently, 8 at a time
    const scrapeLimit = pLimit(8);
    const scrapeJobs = ORGS.flatMap(org =>
      arts[org].slice(0, 16).map((a, i) => ({ org, a, i, total: Math.min(arts[org].length, 16) }))
    );
    await Promise.allSettled(scrapeJobs.map(({ org, a, i, total }) => scrapeLimit(async () => {
      if (!a.url) return;
      const txt = await serperScrape(a.url, cfg.SERPER_KEY);
      if (txt && txt.length > 300) {
        a.fullText = txt;
        cb(`  [${org} ${i + 1}/${total}] scraped ${txt.length} chars`, "ok");
      } else {
        // Scrape failed — fall back to snippet so org mention can still be checked
        a.fullText = `TITLE: ${a.title}\nSNIPPET: ${a.snippet || ""}`;
        cb(`  [${org} ${i + 1}/${total}] snippet fallback`, "warn");
      }
    })));
  }
  // Any article not in the scrape slice (e.g. TV articles added after the first 16)
  // must still get a fallback fullText so they are not silently dropped by the filter below
  for (const org of ORGS) {
    arts[org].forEach(a => {
      if (!a.fullText) {
        a.fullText = `TITLE: ${a.title}\nSNIPPET: ${a.snippet || ""}`;
      }
    });
  }

  // ── STEP 1d: Require org name in scraped body text ───────────
  // Serper can return articles where the org name appears in page metadata,
  // sidebar, or related-links — not in the article body itself. This filter
  // drops those without an API call. Snippet-only articles (scrape failed)
  // bypass and proceed to Haiku which can handle partial context.
  cb(`\nSTEP 1d/6 — Filtering by org presence in scraped text...`, "head");
  for (const org of ORGS) {
    const before = arts[org].length;
    const orgLower = org.toLowerCase();
    const abbr = getAbbreviation(org);
    const abbrRe = abbr
      ? new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      : null;

    arts[org] = arts[org].filter(a => {
      if (!a.fullText || a.fullText.length < 100) return false;
      // Snippet-only: can't verify body text — pass to Haiku
      if (a.snippetOnly) return true;
      const text = a.fullText.toLowerCase();
      if (text.includes(orgLower)) return true;
      // Word-boundary abbreviation match for abbr-search results
      if (abbrRe && abbrRe.test(a.fullText)) return true;
      return false;
    });

    const dropped = before - arts[org].length;
    cb(
      `  ${org}: ${dropped > 0 ? `dropped ${dropped} (no org mention) →` : "all have org mention →"} ${arts[org].length} articles`,
      arts[org].length > 0 ? "ok" : "warn",
    );
  }

  // ── STEP 1e: Haiku citation filter — drop incidental mentions ─
  cb(`\nSTEP 1e/6 — Haiku citation filter (contributor mentions only)...`, "head");
  if (cfg.CLAUDE_KEY) {
    const limit1e = pLimit(2); // 2 orgs in parallel — Haiku RPM is tight under concurrent load
    await Promise.allSettled(ORGS.map(org => limit1e(async () => {
      const before = arts[org].length;
      if (!before) return;

      const batches = [];
      for (let i = 0; i < arts[org].length; i += 10) batches.push(arts[org].slice(i, i + 10));

      const toKeep = new Set();

      for (const batch of batches) {
        const batchText = batch.map((a, j) => {
          const term = a.matchTerm || org;
          const textWindow = extractRelevantWindow(a.fullText || "", term, 800);
          const note = a.snippetOnly ? " [snippet only — no full text available]" : "";
          return `[${j}] TITLE: ${a.title}\nSOURCE: ${a.source}${note}\nCONTENT: ${textWindow}`;
        }).join("\n===\n");

        const prompt = `You are filtering news articles for the organisation "${org}" (air quality / environment sector).

DEFAULT: keep=true. Only set keep=false when you are CERTAIN the mention is trivial. When in doubt, return keep=true.
IMPORTANT: If "${org}" does not appear anywhere in the CONTENT text, set keep=false — the article was fetched by mistake.

Set keep=true if ANY of these apply:
- "${org}"'s research, report, study, data, or statistic is cited or referenced
- A spokesperson, researcher, or expert from "${org}" is quoted or attributed
- The article discusses work, findings, or positions associated with "${org}"
- You have only a snippet and cannot fully assess the article's content

Set keep=false ONLY if you are certain that:
- "${org}" appears solely in a list (e.g. monitoring stations, award recipients, rankings) with no contribution described
- "${org}" is mentioned only as a venue, event host, or location
- "${org}" appears only in a footer, disclaimer, or boilerplate credit line
- The article is exclusively about the org's internal affairs (admissions, sports, HR) with zero AQ relevance

Return ONLY a JSON array with one entry per article:
[{"index":0,"keep":true},{"index":1,"keep":false},...]

Articles:
${batchText}`;

        try {
          const raw = await callClaude(prompt, cfg.CLAUDE_KEY, 600, CLAUDE_MODEL);
          const parsed = extractJsonArray(raw);
          if (parsed) {
            // Build a map from the response; indices absent from the response default to keep=true
            const responseMap = new Map(parsed.map(({ index, keep: k }) => [index, !!k]));
            batch.forEach((a, j) => {
              if (responseMap.get(j) !== false) toKeep.add(a.url || a.title);
            });
          } else {
            // Malformed response — fail open (keep all in batch)
            batch.forEach(a => toKeep.add(a.url || a.title));
          }
        } catch (e) {
          // API error — fail open (keep all in batch)
          batch.forEach(a => toKeep.add(a.url || a.title));
          cb(`  Haiku filter error (${org}): ${e.message}`, "warn");
        }
        await sleep(400);
      }

      arts[org] = arts[org].filter(a => toKeep.has(a.url || a.title));
      const dropped = before - arts[org].length;
      cb(
        `  ${org}: ${dropped > 0 ? `dropped ${dropped} incidental →` : "all substantive →"} ${arts[org].length} articles`,
        arts[org].length > 0 ? "ok" : "warn",
      );
    })));
  }

  // ── STEP 2: Classify with Claude ──────────────────────────
  cb(`\nSTEP 2/6 — Classifying with Claude (batches of 8)...`, "head");
  const cls = {};
  for (const o of ORGS) cls[o] = [];

  {
    const limit2 = pLimit(4); // 4 orgs in parallel; within each org batches stay sequential
    await Promise.allSettled(ORGS.map(org => limit2(async () => {
    // All articles reaching this point already have the org in their scraped text (STEP 1c)
    const al = arts[org].slice(0, 16);
    const batches = [];
    for (let i = 0; i < al.length; i += 8) batches.push(al.slice(i, i + 8));

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];

      // Every article here has the org (or its abbreviation) in its text
      const batchItems = batch.map((a, j) => {
        const ft = a.fullText || "";
        const term = a.matchTerm || org;
        const mc = a.matchTerm ? countAbbrMentions(ft, a.matchTerm) : countMentions(ft, org);
        return { j, a, mc, ft, term };
      });

      if (batchItems.length === 0) continue;

      const txt = batchItems
        .map(({ j, a, mc, ft, term }) => {
          const window = extractRelevantWindow(ft, term, 1500);
          const abbrNote = a.matchTerm ? ` (appears as "${a.matchTerm}")` : '';
          return `[${j}] SOURCE: ${a.source} | DATE: ${a.date} | ORG MENTIONS IN FULL SCRAPED TEXT: ${mc}${abbrNote}\nTITLE: ${a.title}\nCONTENT: ${window}`;
        })
        .join("\n===\n");

      const prompt = `You are a media intelligence analyst classifying Indian news articles about air quality for the organisation "${org}".

For EACH numbered article, return one JSON object with:
- index: the article number shown in [brackets]
- citation_quality: "Data Cited" if a specific number, %, statistic, or named report FROM "${org}" appears in the CONTENT excerpt. "Named Mention" if org is named but no specific data cited. "Not Mentioned" if org does not appear in the excerpt.
- aq_relevant: true ONLY if the article's PRIMARY subject is air quality, pollution, emissions, AQ policy, or environmental health in India. false for everything else — including articles where air quality is a minor mention, and articles about rankings, awards, PhD programs, sports, finance, or general institutional news even if they mention "${org}".
- mention_count: copy the ORG MENTIONS IN FULL SCRAPED TEXT number exactly as given — do not recount from the excerpt
- aq_subtopic: EXACTLY one of: NCAP, Policy, PM2.5 Exposure, Stubble Burning, Clean Air Finance, Vehicular Pollution, Health Impact, Industrial Pollution, Heat-AQI, Brick Kilns, Petrol Emissions, Diesel Emissions, Super Emitters, Thermal Power Plants, Household Pollution, Indoor Pollution, Biomass Air Pollution, Rice Residue Burning, Wheat Residue Burning, Road Dust, General AQ
- evidence_quote: exact phrase ≤12 words from content. "not mentioned" if absent.
- outlet: publication from SOURCE field
- date: date from DATE field
- confidence: "High" or "Low"

Note: CONTENT is a ~700-char window centered on the org's first mention in the scraped text.

Return ONLY a JSON array. No preamble, no markdown.
[{"index":0,"outlet":"Times of India","date":"Mar 5, 2026","citation_quality":"Data Cited","aq_relevant":true,"mention_count":3,"aq_subtopic":"NCAP","evidence_quote":"CEEW found 23 of 131 cities met targets","confidence":"High"}]

ARTICLES:
${txt}`;

      cb(`  ${org} batch ${bi + 1}/${batches.length} (${batchItems.length} articles)...`);
      try {
        const raw = await callClaude(prompt, cfg.CLAUDE_KEY, 2500, CLAUDE_CLASSIFY_MODEL);
        cb(`  preview: ${raw.slice(0, 90).replace(/\n/g, " ")}`, "warn");
        const parsed = parseJ(raw);
        if (parsed && Array.isArray(parsed) && parsed.length > 0) {
          const sorted = [...parsed].sort((a, b) => (a.index || 0) - (b.index || 0));
          cls[org] = cls[org].concat(sorted);
          cb(`  +${sorted.length} classified`, "ok");
        } else {
          cb(`  parse failed: ${raw.slice(0, 80)}`, "err");
        }
      } catch (e) {
        cb(`  Claude error: ${e.message}`, "err");
      }
      await sleep(500);
    }
    cb(
      `  ${org} total classified: ${cls[org].length}`,
      cls[org].length > 0 ? "ok" : "err",
    );
    })));
  }

  // ── STEP 2b: Filter unverified and off-topic articles ─────────
  cb(`\nSTEP 2b/6 — Filtering unverified and off-topic articles...`, "head");
  for (const org of ORGS) {
    const pairs = arts[org].map((a, i) => ({ art: a, cls: cls[org][i] }));
    const kept = pairs.filter(({ cls: c }) => {
      if (!c) return false;
      if (c.aq_relevant !== true) return false; // only keep explicit aq_relevant:true
      if (c.citation_quality === "Not in scraped text") return false;
      return true;
    });
    const removed = pairs.length - kept.length;
    arts[org] = kept.map((p) => p.art);
    cls[org] = kept.map((p) => p.cls).filter(Boolean);
    cb(
      `  ${org}: ${removed > 0 ? `removed ${removed} unverified/off-topic →` : "all passed →"} ${arts[org].length} articles`,
      removed > 0 ? "warn" : "ok",
    );
  }

  // ── STEP 2c: Citation verification (Claude Haiku) ────────────────────────
  cb(`\nSTEP 2c/6 — Citation verification (Claude Haiku)...`, "head");
  {
    const citLimit = pLimit(4);
    await Promise.allSettled(ORGS.map(org => citLimit(async () => {
      const al = arts[org];
      if (!al.length) { cb(`  ${org}: no articles to verify`, 'warn'); return; }
      const batches = [];
      for (let i = 0; i < al.length; i += 8) batches.push(al.slice(i, i + 8));
      let verified = 0;
      for (const batch of batches) {
        const batchText = batch.map((a, j) => {
          const term = a.matchTerm || org;
          const ctx = extractCitationContext(a.fullText || '', term, 2);
          return `[${j}] TITLE: ${a.title}\nCONTEXT (±2 lines around each "${term}" mention):\n${ctx}`;
        }).join('\n===\n');
        const prompt = `You are verifying whether news articles genuinely cite the organisation "${org}" as a source of research or data on air quality in India.

For EACH article below, respond citationVerified=true ONLY if the article:
- Cites a named report, study, or publication by "${org}"
- Attributes a specific statistic, number, or finding to "${org}"
- Quotes a researcher from "${org}" on an air quality topic

Respond citationVerified=false if "${org}" is only mentioned in passing, as an event participant, or without specific attribution of AQ evidence.

Return ONLY a JSON array with no preamble: [{"index":0,"citationVerified":true}, ...]

ARTICLES:
${batchText}`;
        try {
          const raw = await callClaude(prompt, cfg.CLAUDE_KEY, 400, CITATION_HAIKU_MODEL);
          const parsed = parseJ(raw);
          if (parsed && Array.isArray(parsed)) {
            parsed.forEach(r => {
              if (typeof r.index === 'number' && r.index >= 0 && r.index < batch.length) {
                batch[r.index].citationVerified = !!r.citationVerified;
                if (batch[r.index].citationVerified) verified++;
              }
            });
          } else {
            batch.forEach(a => { a.citationVerified = false; });
          }
        } catch (e) {
          cb(`  Citation Haiku error (${org}): ${e.message}`, 'warn');
          batch.forEach(a => { a.citationVerified = false; });
        }
        await sleep(200);
      }
      cb(`  ${org}: ${verified}/${al.length} citation-verified`, verified > 0 ? 'ok' : 'warn');
    })));
  }

  // ── STEP 3: AEO Visibility (via Social Intelligence module) ──
  cb(`\nSTEP 3/6 — AEO / LLM Visibility...`, "head");
  let aeoResults = {};
  let aeoQueriesUsed;
  for (const org of ORGS)
    aeoResults[org] = {
      mentions: 0,
      llmBreakdown: {},
      topResponse: "",
      questionResults: {},
    };
  try {
    aeoResults = await SI.runAEO(cfg, ORGS, cb);
    aeoQueriesUsed = aeoResults._queriesUsed;
    delete aeoResults._queriesUsed; // remove metadata key — Object.values() calls later expect only org entries
    for (const org of ORGS)
      cb(
        `  ${org} AEO mentions: ${aeoResults[org].mentions}`,
        aeoResults[org].mentions > 0 ? "ok" : "warn",
      );
  } catch (e) {
    cb(`  AEO error: ${e.message}`, "err");
  }

  // ── STEP 4: Social Presence (APIdirect.io) ─────────────────────────────
  cb(`\nSTEP 4/6 — Social Presence (APIdirect.io: LI + X + IG)...`, "head");
  const SocialER = require("./social-er");
  let socialERResults = [];
  let socialERHtml = "";
  try {
    socialERResults = await SocialER.run(cfg, ORGS, cb);
    cb(
      `  Social ER complete: ${socialERResults.length} orgs scored`,
      socialERResults.length > 0 ? "ok" : "warn",
    );
  } catch (e) {
    cb(`  Social ER error: ${e.message}`, "err");
  }

  // ── YouTube ER ────────────────────────────────────────────
  cb(`\nSTEP 4b/6 — YouTube ER (YouTube Data API v3)...`, "head");
  const YoutubeER = require("./youtube-er");
  let youtubeERResults = [];
  try {
    youtubeERResults = await YoutubeER.run(cfg, ORGS, cb);
    cb(
      `  YouTube ER complete: ${youtubeERResults.filter(r => r.videoCount > 0).length} orgs with videos`,
      youtubeERResults.some(r => r.videoCount > 0) ? "ok" : "warn",
    );
  } catch (e) {
    cb(`  YouTube ER error: ${e.message}`, "err");
  }

  // Build combined social HTML after both runs complete
  try {
    socialERHtml = SocialER.buildSocialERHtml(socialERResults, youtubeERResults, !!cfg.YOUTUBE_KEY);
  } catch (e) {
    cb(`  Social HTML build error: ${e.message}`, "err");
  }

  // ── Social presence score (0–10) from transparent formula in social-er.js ──
  const erScoreByOrg = {};
  for (const org of ORGS)
    erScoreByOrg[org] = socialERResults.find((r) => r.org === org)?.presenceScore || 0;

  // ── STEP 5: Aggregate + Score ─────────────────────────────
  cb(`\nSTEP 5/6 — Aggregating and scoring...`, "head");
  const data = {};
  for (const org of ORGS) {
    const base = aggregateOrg(arts[org], cls[org], DATE_FROM);
    data[org] = computeScore(
      base,
      aeoResults[org].score,
      erScoreByOrg[org] || 0,
    );
    cb(
      `  ${org}: ${data[org].total} arts | ${data[org].authPct}% auth | ${data[org].dataPct}% data | AEO ${data[org].aeo} | Social ${data[org].social} | score ${data[org].score} (${data[org].grade})`,
      "ok",
    );
  }

  // ── STEP 5a: General AQ landscape fetch (white-space gap analysis) ────────
  cb(
    `\nSTEP 5a/6 — Fetching general AQ landscape (white-space gaps)...`,
    "head",
  );
  let whiteSpaceArticles = [];
  try {
    const orgExclusions = ORGS.map((o) => `-"${o}"`).join(" ");
    const generalQueries = [
      `air quality India ${orgExclusions}`,
      `air pollution India policy ${orgExclusions}`,
      `India AQI PM2.5 health ${orgExclusions}`,
      `India air pollution research study ${orgExclusions}`,
      `India smog pollution news ${orgExclusions}`,
    ];
    const rawGeneral = [];
    for (const q of generalQueries) {
      try {
        const res = await serperSearch(q, cfg.SERPER_KEY);
        rawGeneral.push(...res);
        await sleep(200);
      } catch (e) {
        cb(`  general query error: ${e.message}`, "warn");
      }
    }
    const seen = new Set();
    const deduped = rawGeneral.filter((a) => {
      const u = a.link || a.url || "";
      if (!u || seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    const orgLower = ORGS.map((o) => o.toLowerCase());
    whiteSpaceArticles = deduped.filter((a) => {
      const text = ((a.title || "") + " " + (a.snippet || "")).toLowerCase();
      return !orgLower.some((o) => text.includes(o));
    });
    cb(
      `  ${deduped.length} general AQ articles → ${whiteSpaceArticles.length} exclude tracked orgs`,
      whiteSpaceArticles.length > 0 ? "ok" : "warn",
    );
  } catch (e) {
    cb(`  general AQ fetch error: ${e.message}`, "warn");
  }

  // ── STEP 5b: AI analysis ───────────────────────────────────
  cb(
    `\nSTEP 5b/6 — AI analysis (executive summary, gap narratives, actions)...`,
    "head",
  );
  const orgSummary = ORGS.map((o) => {
    const er = socialERResults.find((r) => r.org === o);
    const yt = youtubeERResults.find((r) => r.org === o);
    return `${o}: ${data[o].total} arts, ${data[o].authPct}% auth, ${data[o].dataPct}% data-specific, AEO ${data[o].aeo} mentions, Social Presence ${data[o].social}/10 (LI=${er?.linkedinPosts || 0} X=${er?.twitterPosts || 0} IG=${er?.instagramPosts || 0} YT=${yt?.videoCount || 0} videos), top outlet: ${data[o].topOutlet}, topics 2+: ${
      Object.entries(data[o].topicCounts)
        .filter(([, v]) => v >= 2)
        .map(([k]) => k)
        .join(",") || "none"
    }`;
  }).join("\n");
  let emerging = [],
    execF = [],
    actions = [];

  try {
    cb("  Executive summary...");
    const r = await callClaude(
      `Write 3 comparative findings for a media intelligence report comparing these orgs on Indian air quality coverage ${DATE_FROM} to ${DATE_TO}.\nOrgs: ${ORGS.join(", ")}\n\nDATA (includes AEO/LLM visibility and social media):\n${orgSummary}\n\nRULES — follow strictly:\n- State facts directly. NEVER use inferential or interpretive language: banned words include "reflects", "indicates", "demonstrates", "shows", "suggests", "implies", "highlights", "underscores", "signals", "points to", "speaks to", "reveals", "evidences".\n- Do NOT editorialize about what numbers mean. Report the numbers and let the reader draw conclusions.\n- Cite ONLY directly observable counts and scores. NEVER use these phrases: "authoritative tone", "institutional credibility", "greater credibility", "more trustworthy".\n- When EITHER compared value is below 10, use raw counts (e.g. "4 vs 1 articles") not percentages. Use "Nx" ratios only when BOTH values are ≥5.\n- Each headline max 12 words. Each detail 2-3 sentences with specific numbers only.\n- section_ref must be one of: "§03 AQ Press Analytics", "§05 Topic Ownership", "§06 Narrative Position", "§07 Citation Quality", "§AEO LLM Visibility", "§Social Media".\nReturn ONLY JSON array of 3: [{"headline":"...","detail":"...","section_ref":"§03 AQ Press Analytics"}]`,
      cfg.CLAUDE_KEY,
      1200,
    );
    execF = parseJ(r) || [];
    cb(`  ${execF.length} findings`, execF.length > 0 ? "ok" : "err");
  } catch (e) {
    cb(`  exec err: ${e.message}`, "err");
  }
  await sleep(300);

  try {
    cb("  White-space gap analysis...");
    if (whiteSpaceArticles.length < 3) {
      cb("  Not enough general AQ articles for gap analysis", "warn");
      emerging = [];
    } else {
      const wsCombined = whiteSpaceArticles
        .slice(0, 50)
        .map(
          (a) =>
            `${a.date || "unknown"}|${a.title || ""}|${a.link || a.url || ""}|${(a.snippet || "").slice(0, 120)}`,
        )
        .join("\n");
      const r = await callClaude(
        `You are analysing the broader Indian air quality media landscape from ${DATE_FROM} to ${DATE_TO}.\n\nThe tracked organisations are: ${ORGS.join(", ")}.\n\nThe articles below are from GENERAL Indian AQ news coverage — these articles do NOT mention any of the tracked organisations. They represent the AQ media landscape where the tracked orgs are ABSENT.\n\nIdentify 2–3 distinct topic clusters from these articles that the tracked organisations are NOT participating in. These are white-space opportunities — genuine gaps where the AQ media conversation is active but the tracked orgs have no presence.\n\nFor each gap topic:\n- "topic": short name (3–5 words)\n- "description": 1 sentence on what this topic covers and why it matters\n- "gap_signal": specific evidence citing article count and themes (e.g. "5 articles on X between March–May 2026, none mentioning ${ORGS.join("/")}")\n- "opportunity": 1 actionable sentence — what a tracked org could publish or say to enter this conversation\n- "supporting_articles": include AT LEAST 3 articles from the list below that belong to this cluster. Only include articles that actually appear in the list.\n\nReturn ONLY JSON array: [{"topic":"...","description":"...","gap_signal":"...","opportunity":"...","supporting_articles":[{"title":"...","url":"...","date":"YYYY-MM-DD"}]}]\n\nARTICLES (date|title|url|snippet):\n${wsCombined}`,
        cfg.CLAUDE_KEY,
        2400,
      );
      emerging = parseJ(r) || [];
      cb(
        `  ${emerging.length} white-space gaps identified`,
        emerging.length > 0 ? "ok" : "warn",
      );
    }
  } catch (e) {
    cb(`  gap analysis err: ${e.message}`, "warn");
  }
  await sleep(300);

  try {
    cb("  Action matrix...");
    const r = await Promise.race([
      callClaude(
        `Generate 4 actions for EACH of these orgs: ${ORGS.join(", ")} — based on Indian AQ media + AEO + social media intelligence.\n${orgSummary}\nWhite-space gap topics (AQ media conversations tracked orgs are absent from): ${emerging.map((e) => e.topic).join(",") || "none"}\nReturn ONLY JSON array of ${ORGS.length * 4} objects: [{"org":"orgname","priority":"Fix Now|Leverage|Optimise|Invest","area":"Media|Topics|Narrative|AEO|Social","action":"...","rationale":"1-2 sentences with specific data"}]`,
        cfg.CLAUDE_KEY,
        Math.min(16000, 2000 + ORGS.length * 800),
        CLAUDE_CLASSIFY_MODEL,
      ),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error("Action matrix timed out after 85s")),
          85000,
        ),
      ),
    ]);
    actions = parseJ(r) || [];
    cb(`  ${actions.length} actions`, actions.length > 0 ? "ok" : "err");
  } catch (e) {
    cb(`  actions err: ${e.message}`, "err");
  }

  // ── Spike annotations for coverage momentum ───────────────
  let spikeAnnotations = [];
  try {
    spikeAnnotations = await computeSpikeAnnotations(arts, ORGS, DATE_FROM, DATE_TO, cfg.CLAUDE_KEY, cb);
    if (spikeAnnotations.length) cb(`  ${spikeAnnotations.length} coverage spike(s) annotated`, "ok");
  } catch (e) {
    cb(`  Spike annotation failed: ${e.message}`, "warn");
  }

  // ── STEP 6: Build outputs ─────────────────────────────────
  cb(`\nSTEP 6/6 — Building report files...`, "head");
  const stamp = new Date().toISOString().slice(0, 10);
  // Truncate filename for large org sets — max 3 names + count
  const orgLabel =
    ORGS.length <= 3
      ? ORGS.join("-vs-")
      : ORGS.slice(0, 3).join("-vs-") + `-and-${ORGS.length - 3}-more`;
  const base = `aq-report-${orgLabel}-${stamp}`;
  const htmlFile = path.join(cfg.outDir, `${base}.html`);
  const html = buildHTML(
    data,
    {},
    emerging,
    execF,
    actions,
    arts,
    aeoResults,
    null,
    cfg,
    socialERHtml,
    socialERResults,
    youtubeERResults,
    spikeAnnotations,
    aeoQueriesUsed,
  );
  fs.writeFileSync(htmlFile, html, "utf8");
  cb(`  HTML: ${base}.html (${Math.round(html.length / 1024)}KB)`, "ok");

  cb(`\n✓ Done — ${base}.html`, "ok");

  const SERPER_COST_PER_QUERY = 0.001;
  const CLAUDE_INPUT_COST_PER_M = 1.0;
  const CLAUDE_OUTPUT_COST_PER_M = 5.0;
  const USD_TO_INR = 84;
  const serperCostUSD = costTracker.serperQueries * SERPER_COST_PER_QUERY;
  const claudeCostUSD =
    (costTracker.claudeInputTokens / 1_000_000) * CLAUDE_INPUT_COST_PER_M +
    (costTracker.claudeOutputTokens / 1_000_000) * CLAUDE_OUTPUT_COST_PER_M;
  const totalUSD = serperCostUSD + claudeCostUSD;
  const totalINR = totalUSD * USD_TO_INR;
  cb("cost", {
    serperQueries: costTracker.serperQueries,
    serperCostUSD: serperCostUSD.toFixed(4),
    claudeInputTokens: costTracker.claudeInputTokens,
    claudeOutputTokens: costTracker.claudeOutputTokens,
    claudeCostUSD: claudeCostUSD.toFixed(4),
    totalUSD: totalUSD.toFixed(4),
    totalINR: Math.round(totalINR),
  });

  return { htmlFile, htmlName: `${base}.html` };
}

// ══════════════════════════════════════════════════════════════════════════
//  PPTX BUILDER
// ══════════════════════════════════════════════════════════════════════════
async function buildPPTX(
  data,
  comps,
  emerging,
  execF,
  actions,
  arts,
  aeoResults,
  socialERResults,
  youtubeERResults,
  outFile,
  cfg,
) {
  const { ORGS, DATE_FROM, DATE_TO, CLIENT_NAME } = cfg;
  const pres = new PptxGen();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Emerald AI";
  pres.title = `AQ Media Intelligence — ${ORGS.join(" vs ")}`;

  const BG = "0a0e17",
    CARD = "111520",
    CARD2 = "181e2e",
    BORD = "252d40";
  const TXT = "d8e4f0",
    MUTED = "8fa3b8",
    AMBER = "c9922a",
    GOOD = "4caf74",
    WARN = "d4a017";

  const darkBg = (sl) => {
    sl.background = { color: BG };
  };
  const eyebrow = (sl, txt, y = 0.25) =>
    sl.addText(txt.toUpperCase(), {
      x: 0.5,
      y,
      w: 12.3,
      h: 0.22,
      fontSize: 9,
      bold: true,
      color: AMBER,
      charSpacing: 3,
      fontFace: "Calibri",
    });
  const stitle = (sl, txt, y = 0.52) =>
    sl.addText(txt, {
      x: 0.5,
      y,
      w: 12.3,
      h: 0.55,
      fontSize: 28,
      bold: true,
      color: TXT,
      fontFace: "Cambria",
    });
  const card = (sl, x, y, w, h) =>
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w,
      h,
      fill: { color: CARD },
      line: { color: BORD, width: 0.5 },
      rectRadius: 0.08,
    });
  const footer = (sl) =>
    sl.addText(
      `Emerald AI · AQ Intelligence · ${DATE_FROM} to ${DATE_TO} · CONFIDENTIAL`,
      {
        x: 0.5,
        y: 7.15,
        w: 12.3,
        h: 0.22,
        fontSize: 8,
        color: MUTED,
        fontFace: "Calibri",
      },
    );

  // Slide 1: Cover
  {
    const sl = pres.addSlide();
    darkBg(sl);
    sl.addShape(pres.shapes.RECTANGLE, {
      x: 0,
      y: 0,
      w: 13.3,
      h: 2.4,
      fill: { color: "111520" },
      line: { color: "111520" },
    });
    sl.addText("AIR QUALITY MEDIA INTELLIGENCE", {
      x: 0.6,
      y: 0.48,
      w: 12,
      h: 0.38,
      fontSize: 11,
      color: AMBER,
      charSpacing: 4,
      bold: true,
      fontFace: "Calibri",
    });
    sl.addText("Air Quality\nTRIPLE Media Analytics", {
      x: 0.6,
      y: 0.92,
      w: 10,
      h: 1.3,
      fontSize: 36,
      bold: true,
      color: TXT,
      fontFace: "Cambria",
    });
    // Org pills: 2 rows if >6 orgs, pill width adapts to count
    {
      const pillsPerRow =
        ORGS.length <= 6 ? ORGS.length : Math.ceil(ORGS.length / 2);
      const pillW = Math.min(
        2.3,
        (12.3 - 0.1 * (pillsPerRow - 1)) / pillsPerRow,
      );
      ORGS.forEach((org, i) => {
        const c = orgPptx(i);
        const col = i % pillsPerRow;
        const row = Math.floor(i / pillsPerRow);
        const px = 0.6 + col * (pillW + 0.1);
        const py = 2.55 + row * 0.55;
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, {
          x: px,
          y: py,
          w: pillW,
          h: 0.44,
          fill: { color: c, transparency: 82 },
          line: { color: c, width: 1 },
          rectRadius: 0.05,
        });
        sl.addText(org.length > 12 ? org.slice(0, 12) + "…" : org, {
          x: px,
          y: py,
          w: pillW,
          h: 0.44,
          fontSize: Math.max(9, 13 - Math.floor(ORGS.length / 4)),
          bold: true,
          color: TXT,
          fontFace: "Calibri",
          align: "center",
          valign: "middle",
        });
      });
    }
    sl.addText(`Period: ${DATE_FROM}  →  ${DATE_TO}`, {
      x: 0.6,
      y: 3.2,
      w: 6,
      h: 0.28,
      fontSize: 12,
      color: MUTED,
      fontFace: "Calibri",
    });
    // AEO indicator on cover
    const hasAEO = Object.values(aeoResults).some((v) => v.mentions > 0);
    if (hasAEO)
      sl.addText("✓ LLM Visibility", {
        x: 8,
        y: 3.2,
        w: 2.5,
        h: 0.26,
        fontSize: 10,
        color: GOOD,
        fontFace: "Calibri",
      });
    const hasER = socialERResults && socialERResults.length > 0;
    if (hasER)
      sl.addText(`✓ Social Presence: ${socialERResults.length} orgs (Serper)`, {
        x: 8,
        y: 3.52,
        w: 5.3,
        h: 0.26,
        fontSize: 10,
        color: GOOD,
        fontFace: "Calibri",
      });
    sl.addText(
      `Prepared for ${CLIENT_NAME || "client"} · Generated ${new Date().toISOString().slice(0, 10)} · CONFIDENTIAL`,
      {
        x: 0.6,
        y: 7.1,
        w: 12,
        h: 0.26,
        fontSize: 9,
        color: MUTED,
        fontFace: "Calibri",
      },
    );
  }

  // Slide 2: Executive Summary
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Section 01");
    stitle(sl, "Executive Summary");
    const findings =
      execF.length > 0
        ? execF.slice(0, 3)
        : [
            {
              headline: `${ORGS[0]} leads AQ coverage`,
              detail:
                ORGS.map((o) => `${o}: ${data[o]?.total || 0} articles`).join(
                  ", ",
                ) + ".",
              section_ref: "§03",
            },
            {
              headline: "Primary Source rates vary across orgs",
              detail:
                ORGS.map(
                  (o) => `${o}: ${data[o]?.authPct || 0}% primary source`,
                ).join(", ") + ".",
              section_ref: "§06 Narrative Position",
            },
            {
              headline: "AEO/LLM visibility remains a shared gap",
              detail:
                ORGS.map((o) => `${o}: AEO ${data[o]?.aeo || 0} mentions`).join(
                  ", ",
                ) + ".",
              section_ref: "§AEO",
            },
          ];
    findings.forEach((f, i) => {
      const y = 1.28 + i * 1.58;
      card(sl, 0.5, y, 12.3, 1.44);
      sl.addText(String(i + 1), {
        x: 0.65,
        y: y + 0.1,
        w: 0.5,
        h: 0.9,
        fontSize: 36,
        color: AMBER,
        fontFace: "Cambria",
        opacity: 0.5,
      });
      sl.addText(f.headline || "", {
        x: 1.3,
        y: y + 0.12,
        w: 10.8,
        h: 0.38,
        fontSize: 14,
        bold: true,
        color: TXT,
        fontFace: "Calibri",
      });
      sl.addText(f.detail || "", {
        x: 1.3,
        y: y + 0.54,
        w: 10.8,
        h: 0.72,
        fontSize: 11,
        color: MUTED,
        fontFace: "Calibri",
      });
    });
    footer(sl);
  }

  // Slide 3: AQ Press Analytics
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Section 02a");
    stitle(sl, "Press Analytics");
    const tot = ORGS.reduce((s, o) => s + (data[o]?.total || 0), 0);
    const chartData = [
      {
        name: "AQ Articles",
        labels: ORGS,
        values: ORGS.map((o) => data[o]?.total || 0),
      },
    ];
    sl.addChart(pres.charts.BAR, chartData, {
      x: 0.5,
      y: 1.22,
      w: 7.8,
      h: 4.6,
      barDir: "col",
      chartColors: ORGS.map((_, i) => orgPptx(i)),
      chartArea: { fill: { color: CARD2 } },
      catAxisLabelColor: MUTED,
      valAxisLabelColor: MUTED,
      valGridLine: { color: BORD, size: 0.5 },
      catGridLine: { style: "none" },
      showValue: true,
      dataLabelColor: TXT,
      dataLabelFontSize: 11,
      showLegend: false,
      valAxisLineShow: false,
      catAxisLineShow: false,
      showTitle: false,
    });
    // Stat cards: switch to a table for >4 orgs (cards overflow vertically)
    if (ORGS.length <= 4) {
      ORGS.forEach((org, i) => {
        const d = data[org];
        const y = 1.22 + i * 1.42;
        card(sl, 8.6, y, 4.2, 1.28);
        sl.addText(org, {
          x: 8.78,
          y: y + 0.1,
          w: 3.8,
          h: 0.28,
          fontSize: 11,
          bold: true,
          color: orgPptx(i),
          fontFace: "Calibri",
          charSpacing: 1,
        });
        sl.addText(String(d?.total || 0), {
          x: 8.78,
          y: y + 0.38,
          w: 1.4,
          h: 0.55,
          fontSize: 34,
          bold: true,
          color: TXT,
          fontFace: "Calibri",
        });
        sl.addText("articles", {
          x: 8.78,
          y: y + 0.9,
          w: 1.4,
          h: 0.22,
          fontSize: 10,
          color: MUTED,
          fontFace: "Calibri",
        });
        const pct = tot > 0 ? Math.round(((d?.total || 0) / tot) * 100) : 0;
        sl.addText(`${pct}% share`, {
          x: 10.3,
          y: y + 0.38,
          w: 2.3,
          h: 0.28,
          fontSize: 12,
          color: AMBER,
          fontFace: "Calibri",
          bold: true,
        });
        sl.addText(`Top: ${d?.topOutlet || "N/A"}`, {
          x: 10.3,
          y: y + 0.7,
          w: 2.3,
          h: 0.22,
          fontSize: 10,
          color: MUTED,
          fontFace: "Calibri",
        });
      });
    } else {
      // Summary table for 5+ orgs
      const trows = [
        [
          {
            text: "Org",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
            },
          },
          {
            text: "Articles",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "Share",
            options: {
              bold: true,
              color: AMBER,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "Top Outlet",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
            },
          },
        ],
        ...ORGS.map((org, i) => {
          const d = data[org];
          const pct = tot > 0 ? Math.round(((d?.total || 0) / tot) * 100) : 0;
          return [
            {
              text: org,
              options: {
                bold: true,
                color: orgPptx(i),
                fontSize: 10,
                fill: { color: CARD },
              },
            },
            {
              text: String(d?.total || 0),
              options: {
                color: TXT,
                fontSize: 11,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: pct + "%",
              options: {
                color: AMBER,
                fontSize: 11,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: d?.topOutlet || "N/A",
              options: { color: MUTED, fontSize: 9, fill: { color: CARD } },
            },
          ];
        }),
      ];
      sl.addTable(trows, {
        x: 8.5,
        y: 1.22,
        w: 4.3,
        colW: [1.4, 0.85, 0.7, 1.35],
        rowH: 0.32,
        border: { pt: 0.5, color: BORD },
        fontFace: "Calibri",
      });
    }
    sl.addText(
      `Serper News API · ${new Date().toISOString().slice(0, 10)} · AQ-scoped`,
      {
        x: 0.5,
        y: 6.98,
        w: 8,
        h: 0.24,
        fontSize: 9,
        color: MUTED,
        fontFace: "Calibri",
      },
    );
  }

  // Slide 4: Topic Ownership
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Section 04");
    stitle(sl, "Topic Ownership Map");
    // For large org counts: split into groups of 5 — one table block per group
    const ORG_GROUPS = [];
    for (let gi = 0; gi < ORGS.length; gi += 5)
      ORG_GROUPS.push(ORGS.slice(gi, gi + 5));
    ORG_GROUPS.forEach((orgGroup, gIdx) => {
      const colW = [
        2.6,
        ...orgGroup.map(() => (12.3 - 2.6 - 0.1) / orgGroup.length),
      ];
      const hdr = [
        {
          text: "AQ SUB-TOPIC",
          options: {
            bold: true,
            color: MUTED,
            fontSize: 9,
            fill: { color: CARD2 },
            align: "left",
          },
        },
        ...ORGS.map((org, i) => ({
          text: org,
          options: {
            bold: true,
            color: orgPptx(i),
            fontSize: 10,
            fill: { color: CARD2 },
            align: "center",
          },
        })),
      ];
      const rows = [
        hdr,
        ...TOPICS.map((topic) => [
          {
            text: topic,
            options: {
              bold: true,
              color: TXT,
              fontSize: 11,
              fill: { color: CARD },
            },
          },
          ...ORGS.map((org) => {
            const cnt = data[org].topicCounts[topic] || 0;
            const label = cnt >= 5 ? "Leader" : cnt >= 2 ? "Active" : "—";
            const fc = cnt >= 5 ? GOOD : cnt >= 2 ? "2d6ea8" : BORD;
            return {
              text: `${label} · ${cnt}`,
              options: {
                color: cnt >= 2 ? "0a0e17" : MUTED,
                fontSize: 10,
                fill: { color: fc, transparency: cnt >= 2 ? 55 : 92 },
                align: "center",
              },
            };
          }),
        ]),
      ];
      const tableY = gIdx === 0 ? 1.22 : 1.22;
      sl.addTable(rows, {
        x: 0.5,
        y: tableY,
        w: 12.3,
        colW,
        rowH: 0.37,
        border: { pt: 0.5, color: BORD },
        fontFace: "Calibri",
      });
      if (gIdx === ORG_GROUPS.length - 1)
        sl.addText(
          "Bar length = relative article count per topic · Clustered by Claude Haiku",
          {
            x: 0.5,
            y: 6.98,
            w: 12.3,
            h: 0.24,
            fontSize: 9,
            color: MUTED,
            fontFace: "Calibri",
          },
        );
    }); // end ORG_GROUPS.forEach
  }

  // Slide 6: Narrative & Citation
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Sections 05 & 06");
    stitle(sl, "Narrative Position & Citation Quality");
    // For large org counts: reduce card height and font sizes to fit
    const cw = Math.min(3.7, 12.3 / ORGS.length - 0.2);
    const cardH = ORGS.length <= 4 ? 2.68 : ORGS.length <= 7 ? 2.0 : 1.6;
    const bigFontSz = ORGS.length <= 4 ? 34 : ORGS.length <= 7 ? 22 : 16;
    ORGS.forEach((org, i) => {
      const d = data[org];
      const x = 0.5 + i * (cw + 0.25);
      card(sl, x, 1.28, cw, cardH);
      sl.addText(org, {
        x: x + 0.15,
        y: 1.38,
        w: cw - 0.3,
        h: 0.28,
        fontSize: 11,
        bold: true,
        color: orgPptx(i),
        fontFace: "Calibri",
        charSpacing: 1,
      });
      sl.addText(`${d.authPct}%`, {
        x: x + 0.15,
        y: 1.7,
        w: cw * 0.48,
        h: 0.68,
        fontSize: bigFontSz,
        bold: true,
        color: orgPptx(i),
        fontFace: "Calibri",
      });
      sl.addText("Primary Source", {
        x: x + 0.15,
        y: 2.36,
        w: cw * 0.48,
        h: 0.24,
        fontSize: 10,
        color: MUTED,
        fontFace: "Calibri",
      });
      sl.addShape(pres.shapes.LINE, {
        x: x + cw * 0.5 + 0.08,
        y: 1.7,
        w: 0,
        h: 0.9,
        line: { color: BORD, width: 0.5 },
      });
      sl.addText(`${d.dataPct}%`, {
        x: x + cw * 0.5 + 0.18,
        y: 1.7,
        w: cw * 0.48,
        h: 0.68,
        fontSize: bigFontSz,
        bold: true,
        color: AMBER,
        fontFace: "Calibri",
      });
      sl.addText("Data Cited", {
        x: x + cw * 0.5 + 0.18,
        y: 2.36,
        w: cw * 0.48,
        h: 0.24,
        fontSize: 10,
        color: MUTED,
        fontFace: "Calibri",
      });
      const ex = d.authExamples[0];
      if (ex?.evidence_quote) {
        sl.addText(`"${ex.evidence_quote}"`, {
          x: x + 0.15,
          y: 2.72,
          w: cw - 0.3,
          h: 0.45,
          fontSize: 9,
          color: MUTED,
          fontFace: "Calibri",
          italic: true,
        });
        sl.addText(`${ex.outlet || ""} · ${ex.date || ""}`, {
          x: x + 0.15,
          y: 3.16,
          w: cw - 0.3,
          h: 0.2,
          fontSize: 8,
          color: AMBER,
          fontFace: "Calibri",
        });
      }
    });
    sl.addChart(
      pres.charts.BAR,
      [
        {
          name: "Primary Source %",
          labels: ORGS,
          values: ORGS.map((o) => data[o].authPct || 0),
        },
        {
          name: "Data Cited %",
          labels: ORGS,
          values: ORGS.map((o) => data[o].dataPct || 0),
        },
      ],
      {
        x: 0.5,
        y: 4.2,
        w: 12.3,
        h: 2.7,
        barDir: "col",
        barGrouping: "clustered",
        chartColors: [GOOD, AMBER],
        chartArea: { fill: { color: CARD2 } },
        catAxisLabelColor: MUTED,
        valAxisLabelColor: MUTED,
        valGridLine: { color: BORD, size: 0.5 },
        catGridLine: { style: "none" },
        showValue: true,
        dataLabelColor: TXT,
        dataLabelFontSize: 10,
        showLegend: true,
        legendPos: "t",
        legendColor: TXT,
        legendFontSize: 10,
        valAxisLineShow: false,
        catAxisLineShow: false,
        showTitle: false,
      },
    );
    footer(sl);
  }

  // Slide 7: AEO / LLM Visibility
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "LLM VISIBILITY");
    stitle(sl, "LLM Visibility");
    sl.addText(
      "How often is each organisation cited when AI models answer AQ questions? Metric = raw LLM mentions.",
      {
        x: 0.5,
        y: 1.12,
        w: 12.3,
        h: 0.32,
        fontSize: 12,
        color: MUTED,
        fontFace: "Calibri",
      },
    );

    const hasAEO = Object.values(aeoResults).some((v) => v.mentions > 0);
    if (!hasAEO) {
      card(sl, 0.5, 1.55, 12.3, 2.5);
      sl.addText("AEO data not collected this run.", {
        x: 0.5,
        y: 2.5,
        w: 12.3,
        h: 0.4,
        fontSize: 16,
        color: MUTED,
        fontFace: "Calibri",
        align: "center",
      });
      sl.addText(
        "Add OPENAI_KEY, PERPLEXITY_KEY, or GEMINI_KEY to enable LLM probing.",
        {
          x: 0.5,
          y: 3.0,
          w: 12.3,
          h: 0.4,
          fontSize: 12,
          color: WARN,
          fontFace: "Calibri",
          align: "center",
        },
      );
    } else {
      // Bar chart: raw LLM mentions per org
      const maxMentions = Math.max(
        ...ORGS.map((o) => aeoResults[o].mentions || 0),
        1,
      );
      sl.addChart(
        pres.charts.BAR,
        [
          {
            name: "LLM Mentions",
            labels: ORGS,
            values: ORGS.map((o) => aeoResults[o].mentions || 0),
          },
        ],
        {
          x: 0.5,
          y: 1.55,
          w: 6,
          h: 3.0,
          barDir: "col",
          chartColors: ORGS.map((_, i) => orgPptx(i)),
          chartArea: { fill: { color: CARD2 } },
          catAxisLabelColor: MUTED,
          valAxisLabelColor: MUTED,
          valGridLine: { color: BORD, size: 0.5 },
          catGridLine: { style: "none" },
          showValue: true,
          dataLabelColor: TXT,
          dataLabelFontSize: 12,
          showLegend: false,
          valAxisLineShow: false,
          catAxisLineShow: false,
          showTitle: false,
          valAxisMaxVal: maxMentions,
        },
      );

      // LLM breakdown cards
      const llmNames = [
        ...new Set(
          Object.values(aeoResults).flatMap((v) => Object.keys(v.llmBreakdown)),
        ),
      ];
      ORGS.forEach((org, oi) => {
        const ay = 1.55 + oi * 1.6;
        if (ay > 6.5) return;
        card(sl, 6.8, ay, 5.8, 1.45);
        sl.addText(org, {
          x: 6.95,
          y: ay + 0.1,
          w: 5.5,
          h: 0.28,
          fontSize: 11,
          bold: true,
          color: orgPptx(oi),
          fontFace: "Calibri",
        });
        sl.addText(`${aeoResults[org].mentions} total LLM mentions`, {
          x: 6.95,
          y: ay + 0.42,
          w: 5.5,
          h: 0.24,
          fontSize: 10,
          color: TXT,
          fontFace: "Calibri",
        });
        const bk = aeoResults[org].llmBreakdown;
        const bkStr = Object.entries(bk)
          .map(([k, v]) => `${k}: ${v.mentions}/${AEO_QUESTIONS.length}`)
          .join("  ·  ");
        sl.addText(bkStr || "No LLM data", {
          x: 6.95,
          y: ay + 0.7,
          w: 5.5,
          h: 0.24,
          fontSize: 9,
          color: MUTED,
          fontFace: "Calibri",
        });
        if (aeoResults[org].topResponse) {
          sl.addText(`"${aeoResults[org].topResponse.slice(0, 120)}..."`, {
            x: 6.95,
            y: ay + 1.0,
            w: 5.5,
            h: 0.35,
            fontSize: 8,
            color: MUTED,
            fontFace: "Calibri",
            italic: true,
          });
        }
      });
    }
    sl.addText(
      "AEO questions sent verbatim to GPT-4o mini, Perplexity Sonar, and Gemini 1.5 Flash. Metric = raw LLM mentions.",
      {
        x: 0.5,
        y: 6.98,
        w: 12.3,
        h: 0.24,
        fontSize: 8,
        color: MUTED,
        fontFace: "Calibri",
        italic: true,
      },
    );
    footer(sl);
  }

  // Slide 8: Social Engagement Rate (Serper)
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Social Media Intelligence");
    stitle(sl, "Social Engagement Rate");
    sl.addText(
      "ER = (Likes + Replies + Reposts) / Views × 100, averaged across AQ posts per org. Sources: Serper web search (LinkedIn + X/Twitter) · X metrics via page text scrape.",
      {
        x: 0.5,
        y: 1.12,
        w: 12.3,
        h: 0.32,
        fontSize: 12,
        color: MUTED,
        fontFace: "Calibri",
      },
    );
    const hasSocialER = socialERResults && socialERResults.length > 0;
    if (!hasSocialER) {
      card(sl, 0.5, 1.55, 12.3, 2.0);
      sl.addText("Social ER data not collected this run.", {
        x: 0.5,
        y: 2.3,
        w: 12.3,
        h: 0.4,
        fontSize: 16,
        color: MUTED,
        fontFace: "Calibri",
        align: "center",
      });
      sl.addText(
        "Social AQ Presence powered by Serper web search.",
        {
          x: 0.5,
          y: 2.76,
          w: 12.3,
          h: 0.4,
          fontSize: 12,
          color: WARN,
          fontFace: "Calibri",
          align: "center",
        },
      );
    } else {
      const sorted = [...socialERResults]
        .map((r) => {
          const yt = youtubeERResults.find((y) => y.org === r.org);
          return { ...r, youtubeER: yt?.avgER || yt?.avgViewER || 0 };
        })
        .sort((a, b) => b.presenceScore - a.presenceScore);
      const trows = [
        [
          {
            text: "#",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "Org",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
            },
          },
          {
            text: "Avg ER",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "YouTube ER",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "Instagram ER",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "LinkedIn ER",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
          {
            text: "Posts",
            options: {
              bold: true,
              color: MUTED,
              fontSize: 9,
              fill: { color: CARD2 },
              align: "center",
            },
          },
        ],
        ...sorted.slice(0, 10).map((r, ri) => {
          const orgIdx = ORGS.indexOf(r.org);
          const oc = orgPptx(orgIdx >= 0 ? orgIdx : ri);
          return [
            {
              text: String(r.rank),
              options: {
                color: ri < 3 ? AMBER : MUTED,
                fontSize: 10,
                fill: { color: CARD },
                align: "center",
                bold: ri < 3,
              },
            },
            {
              text: r.org,
              options: {
                bold: true,
                color: oc,
                fontSize: 10,
                fill: { color: CARD },
              },
            },
            {
              text: r.avgER > 0 ? r.avgER + "%" : "—",
              options: {
                bold: true,
                color: r.avgER > 0 ? GOOD : MUTED,
                fontSize: 11,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: r.youtubeER > 0 ? r.youtubeER + "%" : "—",
              options: {
                color: TXT,
                fontSize: 10,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: r.instagramER > 0 ? r.instagramER + "%" : "—",
              options: {
                color: TXT,
                fontSize: 10,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: r.linkedinER > 0 ? r.linkedinER + "%" : "—",
              options: {
                color: TXT,
                fontSize: 10,
                fill: { color: CARD },
                align: "center",
              },
            },
            {
              text: `${r.twitterPosts}T/${r.instagramPosts}I/${r.linkedinPosts}L`,
              options: {
                color: MUTED,
                fontSize: 9,
                fill: { color: CARD },
                align: "center",
              },
            },
          ];
        }),
      ];
      const colW = [0.5, 3.2, 1.3, 1.3, 1.3, 1.3, 1.4];
      sl.addTable(trows, {
        x: 0.5,
        y: 1.55,
        w: 10.3,
        colW,
        rowH: 0.4,
        border: { pt: 0.5, color: BORD },
        fontFace: "Calibri",
      });
    }
    sl.addText(
      "Serper web search: site:linkedin.com/posts + site:x.com queries · X metrics extracted via Serper page text scrape · ER = (likes + replies + reposts) / views × 100",
      {
        x: 0.5,
        y: 6.98,
        w: 12.3,
        h: 0.24,
        fontSize: 8,
        color: MUTED,
        fontFace: "Calibri",
        italic: true,
      },
    );
    footer(sl);
  }

  // Slide 9: White-Space Gaps
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Section 07");
    stitle(sl, "AQ Media White-Space Gaps");
    sl.addText(
      "Topics the broader AQ media is covering that tracked orgs are absent from — narrative opportunities.",
      {
        x: 0.5,
        y: 1.12,
        w: 12.3,
        h: 0.32,
        fontSize: 11,
        color: MUTED,
        fontFace: "Calibri",
        italic: true,
      },
    );
    const narrs =
      emerging.length > 0
        ? emerging.slice(0, 2)
        : [
            {
              topic: "Insufficient data",
              description:
                "Not enough general AQ articles fetched to identify gaps.",
              gap_signal: "",
              opportunity: "",
            },
          ];
    narrs.forEach((n, i) => {
      const y = 1.55 + i * 2.5;
      card(sl, 0.5, y, 12.3, 2.32);
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: 0.5,
        y,
        w: 0.55,
        h: 2.32,
        fill: { color: AMBER, transparency: 78 },
        line: { color: AMBER, width: 0.5 },
        rectRadius: 0.04,
      });
      sl.addText(n.topic || "", {
        x: 1.18,
        y: y + 0.1,
        w: 11.1,
        h: 0.38,
        fontSize: 14,
        bold: true,
        color: TXT,
        fontFace: "Calibri",
      });
      sl.addText(n.description || "", {
        x: 1.18,
        y: y + 0.52,
        w: 11.1,
        h: 0.34,
        fontSize: 11,
        color: MUTED,
        fontFace: "Calibri",
      });
      if (n.gap_signal)
        sl.addText(`Gap: ${n.gap_signal}`, {
          x: 1.18,
          y: y + 0.9,
          w: 11.1,
          h: 0.34,
          fontSize: 10,
          color: WARN,
          fontFace: "Calibri",
        });
      if (n.opportunity)
        sl.addText(`Opportunity: ${n.opportunity}`, {
          x: 1.18,
          y: y + 1.3,
          w: 11.1,
          h: 0.7,
          fontSize: 10,
          color: GOOD,
          fontFace: "Calibri",
        });
    });
    footer(sl);
  }

  // Slide 10: Scorecard — orgs ranked by score, paginate into groups of 5
  {
    const ordinalP = (n) => {
      const s = ["th", "st", "nd", "rd"],
        v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    const ranked = ORGS.map((org, idx) => ({
      org,
      idx,
      score: data[org].score,
    })).sort((a, b) => b.score - a.score);
    let _ls = null,
      _lr = 0;
    ranked.forEach((o, idx) => {
      if (o.score === _ls) {
        o.rank = _lr;
      } else {
        o.rank = idx + 1;
        _lr = idx + 1;
        _ls = o.score;
      }
    });
    const SCORE_GROUPS = [];
    for (let gi = 0; gi < ranked.length; gi += 5)
      SCORE_GROUPS.push(ranked.slice(gi, gi + 5));
    SCORE_GROUPS.forEach((orgGroup, gIdx) => {
      const sl = pres.addSlide();
      darkBg(sl);
      eyebrow(
        sl,
        SCORE_GROUPS.length > 1
          ? `Section 08 — Part ${gIdx + 1} of ${SCORE_GROUPS.length}`
          : "Section 08",
      );
      stitle(sl, "Competitive Scorecard");
      const cw = Math.min(3.7, 12.3 / orgGroup.length - 0.15);
      orgGroup.forEach((entry, i) => {
        const org = entry.org;
        const d = data[org];
        const x = 0.5 + i * (cw + 0.18);
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, {
          x,
          y: 1.28,
          w: cw,
          h: 5.0,
          fill: { color: CARD },
          line: { color: orgPptx(entry.idx), width: 1.5 },
          rectRadius: 0.1,
        });
        sl.addText(org, {
          x,
          y: 1.38,
          w: cw,
          h: 0.28,
          fontSize: 11,
          bold: true,
          color: orgPptx(entry.idx),
          fontFace: "Calibri",
          align: "center",
          charSpacing: 1,
        });
        const rc = entry.rank === 1 ? GOOD : entry.rank <= 3 ? WARN : MUTED;
        sl.addText(ordinalP(entry.rank), {
          x,
          y: 1.68,
          w: cw,
          h: 1.05,
          fontSize: 48,
          bold: true,
          color: rc,
          fontFace: "Cambria",
          align: "center",
        });
        sl.addText(`${d.score} / 100`, {
          x,
          y: 2.72,
          w: cw,
          h: 0.3,
          fontSize: 13,
          color: MUTED,
          fontFace: "Calibri",
          align: "center",
        });
        const bars = [
          { l: "Press", v: d.sov },
          { l: "Narrative", v: d.authPct },
          { l: "Citation", v: d.dataPct },
          { l: "LLM", v: d.aeo },
        ];
        bars.forEach((b, bi) => {
          const by = 3.14 + bi * 0.62;
          sl.addText(b.l, {
            x: x + 0.15,
            y: by,
            w: cw * 0.52,
            h: 0.22,
            fontSize: 10,
            color: MUTED,
            fontFace: "Calibri",
          });
          sl.addShape(pres.shapes.RECTANGLE, {
            x: x + 0.15,
            y: by + 0.24,
            w: cw - 0.3,
            h: 0.1,
            fill: { color: CARD2 },
            line: { color: BORD, width: 0 },
          });
          if (b.v > 0)
            sl.addShape(pres.shapes.RECTANGLE, {
              x: x + 0.15,
              y: by + 0.24,
              w: ((cw - 0.3) * b.v) / 100,
              h: 0.1,
              fill: { color: orgPptx(entry.idx) },
              line: { color: orgPptx(entry.idx), width: 0 },
            });
          sl.addText(
            b.v > 0 ? String(b.v) : b.l === "LLM" ? "N/A" : String(b.v),
            {
              x: x + cw - 0.55,
              y: by,
              w: 0.4,
              h: 0.22,
              fontSize: 10,
              bold: true,
              color: b.v > 0 ? orgPptx(entry.idx) : MUTED,
              fontFace: "Calibri",
              align: "right",
            },
          );
        });
      });
      sl.addText(
        "Score = (SoV×0.25) + (Narrative×0.25) + (Citation×0.20) + (AEO mentions×0.30)",
        {
          x: 0.5,
          y: 6.98,
          w: 12.3,
          h: 0.24,
          fontSize: 9,
          color: MUTED,
          fontFace: "Calibri",
        },
      );
    }); // end SCORE_GROUPS
  }

  // Slide 11: Action Matrix
  {
    const sl = pres.addSlide();
    darkBg(sl);
    eyebrow(sl, "Section 10");
    stitle(sl, "Action Matrix");
    const priColors = {
      "Fix Now": WARN,
      Leverage: GOOD,
      Optimise: "3d8ef0",
      Invest: "e05c5c",
    };
    const byOrg = {};
    ORGS.forEach(
      (o) => (byOrg[o] = (actions || []).filter((a) => a.org === o)),
    );
    let y = 1.28;
    for (const [oi, org] of ORGS.entries()) {
      const orgActions = byOrg[org] || [];
      if (!orgActions.length) continue;
      sl.addText(org, {
        x: 0.5,
        y,
        w: 12.3,
        h: 0.28,
        fontSize: 11,
        bold: true,
        color: orgPptx(oi),
        fontFace: "Calibri",
        charSpacing: 1,
      });
      y += 0.32;
      for (const a of orgActions.slice(0, 4)) {
        if (y > 6.8) break;
        card(sl, 0.5, y, 12.3, 0.72);
        const pc = priColors[a.priority] || AMBER;
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, {
          x: 0.5,
          y,
          w: 1.1,
          h: 0.72,
          fill: { color: pc, transparency: 75 },
          line: { color: pc, width: 0.5 },
          rectRadius: 0.04,
        });
        sl.addText(a.priority || "", {
          x: 0.5,
          y: y + 0.22,
          w: 1.1,
          h: 0.28,
          fontSize: 9,
          bold: true,
          color: TXT,
          fontFace: "Calibri",
          align: "center",
        });
        sl.addText(a.action || "", {
          x: 1.72,
          y: y + 0.06,
          w: 5.6,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: TXT,
          fontFace: "Calibri",
        });
        sl.addText(a.area || "", {
          x: 1.72,
          y: y + 0.38,
          w: 1.2,
          h: 0.22,
          fontSize: 9,
          color: AMBER,
          fontFace: "Calibri",
        });
        sl.addText(a.rationale || "", {
          x: 3.05,
          y: y + 0.38,
          w: 9.55,
          h: 0.28,
          fontSize: 9,
          color: MUTED,
          fontFace: "Calibri",
        });
        y += 0.82;
      }
      y += 0.1;
    }
    footer(sl);
  }

  await pres.writeFile({ fileName: outFile });
}

// ══════════════════════════════════════════════════════════════════════════
//  COVERAGE MOMENTUM CHART
// ══════════════════════════════════════════════════════════════════════════
function momentumSection(arts, ORGS, DATE_FROM, DATE_TO, spikeAnnotations = []) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const start = new Date(DATE_FROM);
  const end   = new Date(DATE_TO);

  // Generate Monday-aligned week start dates
  const weeks = [];
  const cur = new Date(start);
  cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7)); // back to Monday
  if (cur > start) cur.setDate(cur.getDate() - 7);
  while (cur <= end) {
    weeks.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }

  // Count articles per week per org
  const buckets = weeks.map(() => ORGS.map(() => 0));
  ORGS.forEach((org, oi) => {
    (arts[org] || []).forEach((art) => {
      const d = parseDateStr(art.date || "");
      if (!d) return;
      for (let wi = 0; wi < weeks.length; wi++) {
        const wEnd = new Date(weeks[wi]);
        wEnd.setDate(wEnd.getDate() + 7);
        if (d >= weeks[wi] && d < wEnd) { buckets[wi][oi]++; break; }
      }
    });
  });

  // Deduplicated "Press" total — unique articles across all orgs
  const pressSeenKeys = new Set();
  const pressBuckets = weeks.map(() => 0);
  let pressTotal = 0;
  Object.values(arts).flat().forEach(art => {
    const k = art.url || art.title;
    if (pressSeenKeys.has(k)) return;
    pressSeenKeys.add(k);
    pressTotal++;
    const d = parseDateStr(art.date || "");
    if (!d) return;
    for (let wi = 0; wi < weeks.length; wi++) {
      const wEnd = new Date(weeks[wi]);
      wEnd.setDate(wEnd.getDate() + 7);
      if (d >= weeks[wi] && d < wEnd) { pressBuckets[wi]++; break; }
    }
  });
  const PRESS_COLOR = "8492a6";

  const maxCount = Math.max(...buckets.flat(), ...pressBuckets, 1);
  const orgColors = ORGS.map((_, i) => ORG_COLORS_HEX[i % ORG_COLORS_HEX.length]);
  const totalPerOrg = ORGS.map((o) => (arts[o] || []).length);

  const legend = [
    `<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted2)"><div style="width:10px;height:10px;border-radius:2px;flex-shrink:0;background:#${PRESS_COLOR};opacity:0.7"></div>Press total: <strong style="color:var(--text);font-weight:600">${pressTotal}</strong></div>`,
    ...ORGS.map((o, i) =>
      `<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted2)"><div style="width:10px;height:10px;border-radius:2px;flex-shrink:0;background:#${orgColors[i]}"></div>${esc(o)}: <strong style="color:var(--text);font-weight:600">${totalPerOrg[i]}</strong></div>`
    )
  ].join("");

  const weekBars = weeks.map((w, wi) => {
    const label = `${String(w.getMonth() + 1).padStart(2, "0")}-${String(w.getDate()).padStart(2, "0")}`;
    const pressCount = pressBuckets[wi];
    const pressH = pressCount > 0 ? Math.max(2, Math.round((pressCount / maxCount) * 76)) : 2;
    const pressBar = `<div style="flex:1;border-radius:2px 2px 0 0;min-height:2px;background:#${PRESS_COLOR};height:${pressH}px;opacity:0.55" title="Press total: ${pressCount}"></div>`;
    const bars = [pressBar, ...ORGS.map((org, oi) => {
      const count = buckets[wi][oi];
      const h = count > 0 ? Math.max(2, Math.round((count / maxCount) * 76)) : 2;
      return `<div style="flex:1;border-radius:2px 2px 0 0;min-height:2px;background:#${orgColors[oi]};height:${h}px" title="${esc(org)}: ${count}"></div>`;
    })].join("");
    const isLast = wi === weeks.length - 1;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px${isLast ? "" : ";border-right:1px solid rgba(94,116,148,0.18);padding-right:3px;margin-right:1px"}"><div style="width:100%;display:flex;gap:2px;align-items:flex-end;height:76px">${bars}</div><div style="font-family:monospace;font-size:9px;color:#5e7494;text-align:center">${label}</div></div>`;
  }).join("");

  const summary = ORGS.map((o, i) => `${esc(o)}: ${totalPerOrg[i]}`).join(" · ");

  const spikeCards = spikeAnnotations.length
    ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:20px">
${spikeAnnotations.sort((a, b) => b.count - a.count).map((s) => {
  const orgIdx = ORGS.indexOf(s.org);
  const col = ORG_COLORS_HEX[orgIdx % ORG_COLORS_HEX.length] || "3d8ef0";
  const outlets = [...new Set(s.articles.map((a) => a.source || "").filter(Boolean))].slice(0, 4).join(", ");
  return `<div style="display:flex;gap:14px;align-items:flex-start;padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-left:3px solid #${col};border-radius:6px">
  <div style="flex-shrink:0;font-family:monospace;font-size:10px;color:var(--muted);width:80px;padding-top:1px">${esc(s.wLabel)}</div>
  <div style="flex:1">
    <div style="font-size:12px;font-weight:700;color:#${col};margin-bottom:3px">${esc(s.org)} spike: ${s.count} articles</div>
    ${s.annotation ? `<div style="font-size:12px;color:var(--text);line-height:1.55">${esc(s.annotation)}</div>` : ""}
    ${outlets ? `<div style="margin-top:4px;font-size:11px;color:var(--muted2)">${esc(outlets)}</div>` : ""}
  </div>
</div>`;
}).join("")}
</div>`
    : "";

  return `
<section class="sec" id="momentum"><div class="sh"><div class="se">Section 02c</div><h2 class="st">Coverage Momentum</h2>
<div class="sd">Weekly AQ article volume per organisation over the report period. Spikes are identified and traced to triggering events.</div><div class="sdiv"></div></div>
<div class="mch"><div style="margin-bottom:12px"><div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Weekly article volume &mdash; AQ-scoped</div><div style="font-size:11px;color:var(--muted);margin-bottom:10px">${esc(DATE_FROM)} to ${esc(DATE_TO)}</div><div style="display:flex;gap:12px;flex-wrap:wrap">${legend}</div></div>
<div class="wbars">${weekBars}</div>
<div style="font-size:10px;color:var(--muted);margin-top:6px">Bar height = article count that week. Hover for exact count. Spikes annotated below.</div>
</div>${spikeCards}</section>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  HTML BUILDER  (adds AEO + Social sections)
// ══════════════════════════════════════════════════════════════════════════
function buildHTML(
  data,
  comps,
  emerging,
  execF,
  actions,
  arts,
  aeoResults,
  pptxFilename,
  cfg,
  socialERHtml = "",
  socialERResults = [],
  youtubeERResults = [],
  spikeAnnotations = [],
  aeoQueriesUsed = null,
) {
  const { ORGS, DATE_FROM, DATE_TO, CLIENT_NAME } = cfg;
  const now = new Date().toUTCString();
  const tot = ORGS.reduce((s, o) => s + (data[o]?.total || 0), 0);
  const printTot = ORGS.reduce((s, o) => s + PRINT_OUTLETS.reduce((ps, outlet) => ps + (data[o]?.outletCounts[outlet] || 0), 0), 0);
  const tvTot = ORGS.reduce((s, o) => s + ALL_TV_CHANNELS.reduce((ts, ch) => ts + (data[o]?.outletCounts[ch] || 0), 0), 0);

  function sovBar() {
    const bars = ORGS.map((org, i) => {
      const pct =
        tot > 0 ? Math.round(((data[org]?.total || 0) / tot) * 100) : 0;
      return `<div style="background:${orgHex(i)};width:${pct}%;display:flex;align-items:center;padding-left:9px;font-family:monospace;font-size:11px;font-weight:500;color:#fff;min-width:0;overflow:hidden">${data[org]?.total || 0}</div>`;
    }).join("");
    return `<div style="height:28px;background:#1e2638;border-radius:4px;overflow:hidden;display:flex;margin-bottom:12px">${bars}</div>`;
  }

  function sovByOrgTable() {
    const activeOutlets = PRINT_OUTLETS.filter((outlet) =>
      ORGS.some((o) => (data[o]?.outletCounts[outlet] || 0) > 0)
    );
    if (!activeOutlets.length)
      return `<p style="color:var(--muted);font-size:12px">No newspaper site coverage indexed in this period.</p>`;
    return `<table class="nt"><thead><tr><th>Org</th>${activeOutlets.map((o) => `<th>${esc(o)}</th>`).join("")}</tr></thead><tbody>
${ORGS.map((org, i) => `<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${activeOutlets.map((outlet) => {
      const evArts = (arts[org] || []).filter((a) => canonOutlet(a.source || "") === outlet);
      const n = evArts.length;
      if (!n) return `<td style="font-family:monospace;color:var(--muted)">0</td>`;
      const uid = `sov_${org}_${outlet}`.replace(/\W/g, "_");
      const links = evArts.slice(0, 5).map((a) =>
        `<a href="${esc(a.url || "#")}" target="_blank" style="display:block;font-size:10px;color:var(--amber);text-decoration:none;margin-top:3px;line-height:1.4;white-space:normal;max-width:220px" title="${esc(a.title || '')}">${esc((a.title || "").length > 70 ? (a.title || "").slice(0, 70) + "…" : (a.title || ""))}</a>`
      ).join("");
      return `<td style="font-family:monospace"><strong>${n}</strong><br><span onclick="td('${uid}')" style="font-size:10px;color:var(--muted2);cursor:pointer;user-select:none">↗ sources</span><div id="${uid}" style="display:none">${links}</div></td>`;
    }).join("")}</tr>`).join("\n")}
</tbody></table>`;
  }

  function sovByOrgTVTable() {
    const activeChs = ALL_TV_CHANNELS.filter((ch) =>
      ORGS.some((o) => (data[o]?.outletCounts[ch] || 0) > 0)
    );
    if (!activeChs.length)
      return `<p style="color:var(--muted);font-size:12px">No TV channel coverage indexed in this period.</p>`;
    return `<table class="nt"><thead><tr><th>Org</th>${activeChs.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
${ORGS.map((org, i) => `<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${activeChs.map((ch) => {
      const evArts = (arts[org] || []).filter((a) => canonOutlet(a.source || "") === ch);
      const n = evArts.length;
      if (!n) return `<td style="font-family:monospace;color:var(--muted)">0</td>`;
      const uid = `sov2_${org}_${ch}`.replace(/\W/g, "_");
      const links = evArts.slice(0, 5).map((a) =>
        `<a href="${esc(a.url || "#")}" target="_blank" style="display:block;font-size:10px;color:var(--amber);text-decoration:none;margin-top:3px;line-height:1.4;white-space:normal;max-width:220px" title="${esc(a.title || '')}">${esc((a.title || "").length > 70 ? (a.title || "").slice(0, 70) + "…" : (a.title || ""))}</a>`
      ).join("");
      return `<td style="font-family:monospace"><strong>${n}</strong><br><span onclick="td('${uid}')" style="font-size:10px;color:var(--muted2);cursor:pointer;user-select:none">↗ sources</span><div id="${uid}" style="display:none">${links}</div></td>`;
    }).join("")}</tr>`).join("\n")}
</tbody></table>`;
  }

  function outletRows() {
    return PRINT_OUTLETS.map((outlet) => {
      if (!ORGS.some((o) => (data[o]?.outletCounts[outlet] || 0) > 0))
        return "";
      const orgCnts = ORGS.map((o, i) => ({
        o,
        i,
        n: data[o]?.outletCounts[outlet] || 0,
      }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n);
      if (!orgCnts.length) return "";
      const total = orgCnts.reduce((s, x) => s + x.n, 0);
      const top3 = orgCnts
        .slice(0, 3)
        .map(
          (x) =>
            `<span style="display:inline-flex;align-items:center;gap:4px;font-family:monospace;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;background:${orgHex(x.i)}1a;color:${orgHex(x.i)};border:1px solid ${orgHex(x.i)}4d;white-space:nowrap">${esc(x.o)} (${x.n})</span>`,
        )
        .join(" ");
      const more =
        orgCnts.length > 3
          ? `<span style="font-family:monospace;font-size:10px;color:var(--muted)"> +${orgCnts.length - 3} more</span>`
          : "";

      // Advantage: ranked list of all orgs for this outlet
      let advantage;
      if (!orgCnts.length) {
        advantage = `<span style="color:var(--muted)">—</span>`;
      } else {
        const rankColors = ['#4caf74', '#c9922a', '#5e7494'];
        const rankBadges = orgCnts.map((x, ri) => {
          const rc = rankColors[ri] || '#5e7494';
          return `<div style="display:flex;align-items:center;gap:4px"><span style="font-family:monospace;font-size:9px;font-weight:700;color:${rc};width:18px;flex-shrink:0">#${ri+1}</span><span style="font-size:10px;color:${orgHex(x.i)};font-weight:600">${esc(x.o)}</span><span style="font-family:monospace;font-size:9px;color:var(--muted)">(${x.n})</span></div>`;
        });
        advantage = `<div style="display:flex;flex-direction:column;gap:3px">${rankBadges.join('')}</div>`;
      }

      const eid = "ot" + outlet.replace(/\W/g, "");
      let evItems = "";
      orgCnts.forEach((x) => {
        arts[x.o]
          .filter((a) => canonOutlet(a.source || "") == outlet)
          .forEach((a) => {
            evItems += `<div class="ei"><div class="en" style="color:${orgHex(x.i)};font-weight:600">${esc(x.o)}</div><div class="eb"><div class="eq">${esc((a.snippet || a.title).slice(0, 130))}</div><div class="es">${esc(outlet)} &middot; ${esc(a.date)}${a.url ? `<br><a href="${esc(a.url)}" target="_blank">${esc(a.url.slice(0, 65))}</a>` : ""}</div></div></div>`;
          });
      });
      return `<tr><td style="font-weight:600">${esc(outlet)}</td><td style="font-family:monospace;font-size:13px;font-weight:700;color:var(--muted2)">${total}</td><td style="line-height:2.2">${top3}${more}</td><td>${advantage}</td><td>${evItems ? `<a class="ctag" onclick="td('${eid}')">&#8599; articles</a><div class="evd" id="${eid}">${evItems}</div>` : '<span class="lc">&#9888; no articles</span>'}</td></tr>`;
    }).join("");
  }

  function topicCards() {
    const topicDisplayNames = {
      NCAP: "NCAP / Policy Targets",
      Policy: "Policy & Regulations",
      "PM2.5 Exposure": "PM2.5 Exposure Mapping",
      "Stubble Burning": "Stubble Burning",
      "Clean Air Finance": "Clean Air Finance",
      "Vehicular Pollution": "Vehicular Pollution",
      "Health Impact": "Health Impact",
      "Industrial Pollution": "Industrial Pollution",
      "Heat-AQI": "Heat-AQI Interaction",
      "Brick Kilns": "Brick Kilns",
      "Petrol Emissions": "Petrol Emissions",
      "Diesel Emissions": "Diesel Emissions",
      "Super Emitters": "Super Emitters",
      "Thermal Power Plants": "Thermal Power Plants",
      "Household Pollution": "Household Pollution",
      "Indoor Pollution": "Indoor Pollution",
      "Biomass Air Pollution": "Biomass Air Pollution",
      "Rice Residue Burning": "Rice Residue Burning",
      "Wheat Residue Burning": "Wheat Residue Burning",
      "Road Dust": "Road Dust",
    };
    const topicSubtitles = {
      NCAP: "National Clean Air Programme progress & compliance",
      Policy: "Air quality regulations, standards, government actions",
      "PM2.5 Exposure": "City & ward-level exposure data, health burden",
      "Stubble Burning": "Parali, enforcement, seasonal contribution",
      "Clean Air Finance": "Funding flows, investment gaps, municipal budgets",
      "Vehicular Pollution": "EV targets, transport emissions, FAME",
      "Health Impact": "Mortality, hospital admissions, DALY data",
      "Industrial Pollution": "Factory emissions, cement, steel plants",
      "Heat-AQI": "Summer heat compounding PM2.5 impacts",
      "Brick Kilns": "Brick kiln emissions, FCBTK, zig-zag technology",
      "Petrol Emissions": "Petrol vehicle tailpipe pollution",
      "Diesel Emissions": "Diesel generators, trucks, buses",
      "Super Emitters": "High-emission point sources, hotspots",
      "Thermal Power Plants": "Coal power plant emissions, FGD",
      "Household Pollution": "Cooking fuel, biomass, LPG substitution",
      "Indoor Pollution": "Indoor air quality, IAQ monitoring",
      "Biomass Air Pollution": "Wood, crop residue, biomass burning",
      "Rice Residue Burning": "Paddy straw burning, Punjab, Haryana",
      "Wheat Residue Burning": "Wheat stubble burning, post-harvest",
      "Road Dust": "Resuspended road dust, unpaved roads",
    };

    // Build topic→org→articles index (join classification with original article for title/url)
    const topicArts = {};
    TOPICS.forEach((tp) => {
      topicArts[tp] = {};
      ORGS.forEach((org) => { topicArts[tp][org] = []; });
    });
    ORGS.forEach((org) => {
      (data[org]?.classifications || []).forEach((c) => {
        const t = (c.aq_subtopic || "").trim();
        const match = TOPICS.find(
          (tp) =>
            tp.toLowerCase() === t.toLowerCase() ||
            t.toLowerCase().includes(tp.toLowerCase().split(" ")[0].toLowerCase()),
        );
        if (match) {
          const art = arts[org]?.[c.index] || {};
          topicArts[match][org].push({ ...c, title: art.title || "", url: art.url || "" });
        }
      });
    });

    // Transposed: orgs as rows, topics as columns
    const theadTopics = TOPICS.map((tk) => {
      const dn = topicDisplayNames[tk] || tk;
      const sub = topicSubtitles[tk] || "";
      return `<th style="padding:8px 12px;text-align:left;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);min-width:120px;vertical-align:bottom;border-left:1px solid var(--border)" title="${esc(sub)}">${esc(dn)}</th>`;
    }).join("");

    const tbodyRows = ORGS.map((org, i) => {
      const orgCells = TOPICS.map((tk) => {
        const artList = topicArts[tk][org] || [];
        const cv = artList.length;
        const label = cv >= 5 ? "Leader" : "Active";
        const [bgCol, borderCol, textCol] = cv >= 5
          ? ["rgba(74,222,128,.10)", "rgba(74,222,128,.30)", "#4ade80"]
          : ["rgba(251,191,36,.10)", "rgba(251,191,36,.30)", "#fbbf24"];
        if (cv === 0) {
          return `<td style="padding:10px 12px;border-bottom:1px solid var(--border);border-left:1px solid var(--border);vertical-align:top"><span style="font-family:monospace;font-size:10px;color:var(--muted)">—</span></td>`;
        }
        const uid = `tm${org.replace(/\W/g,"")}${tk.replace(/\W/g,"")}`;
        const srcLinks = artList.map((a) =>
          a.url
            ? `<a href="${esc(a.url)}" target="_blank" style="display:block;font-size:10px;color:var(--amber);text-decoration:none;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title||a.url)}</a>`
            : `<div style="font-size:10px;color:var(--muted);padding:2px 0">${esc(a.title||"")}</div>`
        ).join("");
        return `<td style="padding:10px 12px;border-bottom:1px solid var(--border);border-left:1px solid var(--border);vertical-align:top">
          <div style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:3px;background:${bgCol};border:1px solid ${borderCol};margin-bottom:5px;white-space:nowrap">
            <span style="font-family:monospace;font-size:10px;font-weight:700;color:${textCol}">${label} &middot; ${cv}</span>
          </div>
          <div><a class="ctag" onclick="td('${uid}')" style="cursor:pointer;font-size:10px;padding:2px 6px;background:rgba(212,160,23,.12);border:1px solid rgba(212,160,23,.25);border-radius:3px;color:var(--amber);font-weight:700;text-decoration:none">&#8599; sources</a><div class="evd" id="${uid}" style="padding:4px 0;border:none;max-height:200px;overflow-y:auto">${srcLinks}</div></div>
        </td>`;
      }).join("");
      return `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap;position:sticky;left:0;background:var(--surface2);z-index:1">
          <span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span>
        </td>
        ${orgCells}
      </tr>`;
    }).join("");

    return `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden"><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--surface2)">
      <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);position:sticky;left:0;background:var(--surface2);z-index:2;white-space:nowrap">Org</th>
      ${theadTopics}
    </tr></thead><tbody>${tbodyRows}</tbody></table></div></div>`;
  }

  function narrTable() {
    const rows = ORGS.map((org, i) => {
      const cls = data[org]?.classifications || [];
      const primary = cls.filter(
        (c) => c.narrative_position === "Primary Source",
      ).length;
      const secondary = cls.filter(
        (c) => c.narrative_position === "Secondary Mention",
      ).length;
      const notM = cls.filter(
        (c) => c.narrative_position === "Not Mentioned",
      ).length;
      const total = cls.length;
      const pct = total > 0 ? Math.round((primary / total) * 100) : 0;
      const exs = cls
        .filter((c) => c.narrative_position === "Primary Source")
        .slice(0, 2);
      const eid = "nex" + org.replace(/\W/g, "");
      const exHtml = exs.length
        ? `<a class="ctag" onclick="td('${eid}')">examples</a><div class="evd" id="${eid}">${exs.map((c) => `<div class="ei"><div class="eb"><div class="eq">${esc(c.evidence_quote || "")}</div><div class="es">${esc(c.outlet || "")} &middot; ${esc(c.date || "")}</div></div></div>`).join("")}</div>`
        : "—";
      return { org, i, primary, secondary, notM, total, pct, exHtml };
    }).sort((a, b) => b.pct - a.pct);
    return `<table class="nt"><thead><tr><th>Org</th><th>Primary Source</th><th>Secondary Mention</th><th>Not Mentioned</th><th>Primary Source %</th><th>Examples</th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(r.i)}">${esc(r.org)}</span></td><td style="font-family:monospace;font-weight:700;color:var(--good)">${r.primary}</td><td style="font-family:monospace;color:var(--muted2)">${r.secondary}</td><td style="font-family:monospace;color:var(--muted)">${r.notM}</td><td><span style="font-family:monospace;font-weight:700;color:${orgHex(r.i)}">${r.pct}%</span></td><td>${r.exHtml}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }

  function donut(pct, color) {
    const da = ((pct / 100) * 163.4).toFixed(1),
      db = (163.4 - da).toFixed(1);
    return `<svg width="64" height="64" viewBox="0 0 64 64" style="flex-shrink:0"><circle cx="32" cy="32" r="26" fill="none" stroke="#1e2638" stroke-width="10"/><circle cx="32" cy="32" r="26" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${da} ${db}" stroke-dashoffset="41" stroke-linecap="round"/><text x="32" y="37" text-anchor="middle" fill="${color}" font-size="13" font-family="Inter" font-weight="700">${pct}%</text></svg>`;
  }

  // AEO Section HTML
  function aeoSection() {
    const hasAEO = Object.values(aeoResults).some((v) => v.mentions > 0);
    const llmNames = [
      ...new Set(
        Object.values(aeoResults).flatMap((v) => Object.keys(v.llmBreakdown)),
      ),
    ];
    const aeoQs = AEO_QUESTIONS.map(
      (q, i) =>
        `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px"><div style="font-family:monospace;font-size:10px;color:var(--amber);flex-shrink:0;padding-top:2px">${i + 1}</div><div style="color:var(--muted2)">${esc(q)}</div></div>`,
    ).join("");
    // Ranking by total mentions for the AEO section header bar
    const aeoRanked = [...ORGS]
      .map((o, i) => ({ o, i, m: aeoResults[o].mentions || 0 }))
      .sort((a, b) => b.m - a.m);
    const maxMentions = Math.max(1, ...aeoRanked.map((x) => x.m));
    const aeoRankBar = aeoRanked
      .map(
        (x, ri) =>
          `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)"><span style="font-family:monospace;font-size:10px;color:var(--muted);width:16px;flex-shrink:0">${ri + 1}</span><span style="font-size:11px;font-weight:600;color:${orgHex(x.i)};width:90px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.o)}</span><div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;background:${orgHex(x.i)};width:${Math.round((x.m / maxMentions) * 100)}%;border-radius:4px"></div></div><span style="font-family:monospace;font-size:11px;font-weight:700;width:36px;text-align:right;color:${orgHex(x.i)};flex-shrink:0">${x.m} <span style="font-weight:400;color:var(--muted)">mentions</span></span></div>`,
      )
      .join("");
    const cards = ORGS.map((org, i) => {
      const a = aeoResults[org];
      const col = orgHex(i);
      const bk = Object.entries(a.llmBreakdown || {})
        .map(
          ([llm, v]) =>
            `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted2)">${esc(llm)}</span><span style="font-family:monospace;font-weight:600;color:${col}">${v.mentions}/${v.total || "?"} mentions</span></div>`,
        )
        .join("");
      return `<div class="cqp" style="border-top:2px solid ${col}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:12px">${esc(org)}</div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          <div style="font-family:monospace;font-size:40px;font-weight:700;color:${col};line-height:1;flex-shrink:0">${a.mentions || 0}</div>
          <div><div style="font-size:12px;color:var(--muted2);margin-bottom:2px">LLM Mentions</div><div style="font-size:11px;color:var(--muted)">${llmNames.length > 0 ? "across " + llmNames.length + " model" + (llmNames.length !== 1 ? "s" : "") : "no models run"}</div></div>
        </div>
        ${bk || '<div style="font-size:11px;color:var(--muted)">No LLM data collected</div>'}
        ${a.topResponse ? `<div class="cqe cqd" style="margin-top:10px"><div class="cqet">Example LLM response</div><div style="color:var(--text);font-family:monospace;font-size:11px;line-height:1.5">&ldquo;${esc(a.topResponse)}&rdquo;</div></div>` : ""}
      </div>`;
    }).join("");
    const grid =
      ORGS.length <= 2
        ? `display:grid;grid-template-columns:repeat(${ORGS.length},1fr);gap:16px;margin-bottom:20px`
        : `display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px`;
    return `
<section class="sec" id="aeo"><div class="sh"><div class="se">LLM Visibility</div><h2 class="st">LLM Visibility</h2>
<div class="sd">How often is each organisation cited when AI models (GPT-4o, Perplexity, Gemini) are asked about Indian air quality? ${hasAEO ? "Probed with " + AEO_QUESTIONS.length + " standard questions per LLM." : "No LLM API keys provided — add keys to enable."}</div><div class="sdiv"></div></div>
${!hasAEO ? `<div style="background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.3);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted2)"><strong style="color:var(--warn)">⚠ AEO data not available</strong> — Add OpenAI, Perplexity, or Gemini API keys and re-run to populate this section.</div>` : ""}
${hasAEO ? `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:20px"><div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px">LLM Mention Ranking</div>${aeoRankBar}</div>` : ""}
<div style="${grid}">${cards}</div>
<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
  <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px">Standard AEO questions (${AEO_QUESTIONS.length} per LLM)</div>
  ${aeoQs}
</div></section>`;
  }

  const clsNotice = ORGS.every((o) => (data[o]?.classified || 0) === 0)
    ? `<div style="background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.3);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted2)"><strong style="color:var(--warn)">&#9888; Classification unavailable</strong> &mdash; Claude API calls failed. Check CLAUDE_KEY and re-run.</div>`
    : "";

  function scRow(label, val, color, barPct) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px"><span style="color:var(--muted2)">${label}</span><div style="flex:1;margin:0 9px;height:4px;background:#1e2638;border-radius:2px;overflow:hidden"><div style="height:100%;border-radius:2px;background:${color};width:${barPct !== undefined ? Math.min(barPct, 100) : val}%"></div></div><span style="font-family:monospace;font-size:11px;font-weight:600;width:30px;text-align:right;color:${color}">${val}</span></div>`;
  }

  const topicCols = `175px ${ORGS.map(() => "1fr").join(" ")}`;
  const orgChips = ORGS.map(
    (o, i) =>
      `<span class="chip" style="background:${orgHex(i)}1a;color:${orgHex(i)};border:1px solid ${orgHex(i)}4d"><span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${orgHex(i)}"></span>${esc(o)}</span>`,
  ).join("");
  const navOrgs = ORGS.map(
    (o) =>
      `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted2);padding:3px 20px"><div style="width:8px;height:8px;border-radius:2px;background:${orgHex(ORGS.indexOf(o))}"></div>${esc(o)}: ${data[o].total} arts</div>`,
  ).join("");

  const ordinal = (n) => {
    const s = ["th", "st", "nd", "rd"],
      v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const rankCol = (r) =>
    r === 1 ? "var(--good)" : r <= 3 ? "var(--amber)" : "var(--muted2)";
  const rankedOrgs = ORGS.map((org, i) => ({
    org,
    i,
    score: data[org].score,
  })).sort((a, b) => b.score - a.score);
  let _lastScore = null,
    _lastRank = 0;
  rankedOrgs.forEach((o, idx) => {
    if (o.score === _lastScore) {
      o.rank = _lastRank;
    } else {
      o.rank = idx + 1;
      _lastRank = idx + 1;
      _lastScore = o.score;
    }
  });
  // Avg citation % used for per-card delta comparison
  const avgCitedPct = ORGS.length
    ? Math.round(
        ORGS.reduce((s, o) => s + (data[o].dataPct || 0), 0) / ORGS.length,
      )
    : 0;
  // Pre-compute max values for bar scaling
  const maxSov  = Math.max(...ORGS.map((o) => data[o].sov     || 0), 1);
  const maxCit  = Math.max(...ORGS.map((o) => data[o].dataPct || 0), 1);
  const maxAeo  = Math.max(...ORGS.map((o) => data[o].aeo     || 0), 1);
  const maxScr  = Math.max(...ORGS.map((o) => data[o].score   || 0), 1);

  const inlineBar = (val, max, col) => {
    const pct = Math.round((val / max) * 100);
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="width:60px;height:5px;background:var(--surface3);border-radius:3px;flex-shrink:0;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${col};border-radius:3px"></div>
      </div>
      <span style="font-family:monospace;font-size:12px;font-weight:600;color:${col}">${val}</span>
    </div>`;
  };

  const scorecardRows = rankedOrgs.map(({ org, i, rank }) => {
    const d   = data[org];
    const col = orgHex(i);
    const er  = socialERResults.find((r) => r.org === org);
    const yt  = youtubeERResults.find((r) => r.org === org);
    const socialScore = d.social || 0;
    const socialCell = socialScore > 0
      ? `<span style="font-family:monospace;font-size:13px;font-weight:600;color:${col}">${socialScore}<span style="font-size:10px;font-weight:400;color:var(--muted)">/10</span></span>`
      : `<span style="font-family:monospace;font-size:11px;color:var(--muted)">—</span>`;
    return `<tr>
      <td style="text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:${rankCol(rank)}">${ordinal(rank)}</td>
      <td><span style="font-size:12px;font-weight:700;color:${col};letter-spacing:.04em">${esc(org)}</span></td>
      <td>${inlineBar(d.sov, maxSov, col)}</td>
      <td>${inlineBar(d.dataPct, maxCit, col)}</td>
      <td>${d.aeo > 0 ? inlineBar(d.aeo, maxAeo, col) : `<span style="font-family:monospace;font-size:11px;color:var(--muted)">—</span>`}</td>
      <td style="text-align:center">${socialCell}</td>
      <td>${inlineBar(d.score, maxScr, col)}</td>
    </tr>`;
  }).join("");

  const scorecards = `<div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="border-bottom:2px solid var(--border)">
        <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap">Rank</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Organisation</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap">Press</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Citation %</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">LLM Mentions</th>
        <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap">Social /10</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--amber);white-space:nowrap">Score</th>
      </tr>
    </thead>
    <tbody>
      ${scorecardRows}
    </tbody>
  </table>
</div>`;

  const appendixSections = ORGS.map((org, orgIdx) => {
    const d = data[org];
    const cqColor = (q) =>
      q === "Data Cited"
        ? "var(--good)"
        : q === "Named Mention"
          ? "var(--muted2)"
          : q === "Not in scraped text"
            ? "#8b7cf8"
            : "var(--muted)";
    const rows = arts[org]
      .map((a, i) => {
        const c = d.classifications[i] || {};
        const cq = c.citation_quality || "—";
        const citBadge = a.citationVerified ? `<span style="display:inline-block;background:rgba(76,175,116,.12);color:var(--good);border:1px solid rgba(76,175,116,.3);border-radius:3px;padding:1px 5px;font-size:9px;font-family:monospace;font-weight:700;margin-left:4px" title="Org appears within 2 lines of AQ keyword">✓ cit</span>` : '';
        return `<tr><td>${i + 1}</td><td>${esc(a.source || "")}</td><td style="font-size:10px">${esc(a.date || "")}</td><td style="max-width:260px">${esc(a.title || "")}${citBadge}</td><td style="font-size:10px;font-family:monospace;color:${cqColor(cq)}">${esc(cq)}</td><td>${a.url ? `<a href="${esc(a.url)}" target="_blank">link</a>` : "—"}</td></tr>`;
      })
      .join("");
    return `<details ${orgIdx === 0 ? 'open' : ''} style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden">
<summary style="padding:10px 16px;cursor:pointer;background:var(--surface2);display:flex;align-items:center;justify-content:space-between;list-style:none;user-select:none">
  <span style="font-size:13px;font-weight:600;color:var(--text)">${esc(org)} <span style="color:var(--muted);font-weight:400">&mdash; ${d.total} articles</span></span>
  <span style="font-family:monospace;font-size:10px;color:var(--muted)">▾</span>
</summary>
<div style="padding:0 0 4px">
<table class="apt"><thead><tr><th>#</th><th>Outlet</th><th>Date</th><th>Headline</th><th>Classification</th><th>URL</th></tr></thead><tbody>${rows}</tbody></table>
</div></details>`;
  }).join("");

  const execCards = (
    execF.length > 0
      ? execF
      : [
          {
            headline: `${ORGS[0]} leads AQ coverage`,
            detail:
              ORGS.map((o) => `${o}: ${data[o]?.total || 0} articles`).join(
                ", ",
              ) + ".",
            section_ref: "§03",
          },
        ]
  )
    .slice(0, 3)
    .map(
      (f, i) =>
        `<div class="fc"><div class="fn">${i + 1}</div><div class="fb"><div class="fh">${esc(f.headline)}</div><div class="fd">${esc(f.detail)}${f.section_ref ? ` <span style="font-family:monospace;font-size:10px;color:var(--muted)">&rarr; ${esc(f.section_ref)}</span>` : ""}</div></div></div>`,
    )
    .join("");

  const emergingCards =
    !emerging || !emerging.length
      ? `<div class="em-card"><div class="em-topic">Insufficient data</div><div class="em-body">Not enough general AQ articles were fetched to identify white-space gaps. Check the Serper key or broaden the date range.</div></div>`
      : emerging
          .map((n) => {
            const articleLinks = (n.supporting_articles || [])
              .map((a) =>
                a.url
                  ? `<div class="em-src"><a href="${esc(a.url)}" target="_blank" style="color:var(--amber);text-decoration:none">${esc(a.title)}</a></div>`
                  : `<div class="em-src">${esc(a.title || a)}</div>`,
              )
              .join("");
            const artCount = (n.supporting_articles || []).length;
            const absentBadges = ORGS.map((o, i) =>
              `<span style="font-family:monospace;font-size:10px;font-weight:700;padding:1px 7px;border-radius:3px;background:${orgHex(i)}1a;color:${orgHex(i)};border:1px solid ${orgHex(i)}4d">${esc(o)}</span>`
            ).join(" ");
            return `<div class="em-card">
<div class="em-hdr"><div class="em-topic">${esc(n.topic)}</div></div>
<div class="em-body">${esc(n.description || "")}</div>
<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
  <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Absent:</span>
  ${absentBadges}
</div>
${articleLinks ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
  ${artCount > 0 ? `<div style="font-family:monospace;font-size:10px;color:var(--muted2);margin-bottom:7px;letter-spacing:.04em">${artCount} article${artCount !== 1 ? "s" : ""} in this narrative</div>` : ""}
  ${articleLinks}
</div>` : ""}
</div>`;
          })
          .join("");

  const pmap = {
    "Fix Now": "pri-fix",
    Leverage: "pri-lev",
    Optimise: "pri-opt",
    Invest: "pri-inv",
  };
  const actionRows =
    !actions || !actions.length
      ? `<tr><td colspan="5" style="color:var(--muted)">Action matrix generation failed</td></tr>`
      : actions
          .map((a) => {
            const oi = ORGS.indexOf(a.org);
            const oc = oi >= 0 ? orgHex(oi) : "#c9922a";
            return `<tr><td style="font-weight:600;color:${oc}">${esc(a.org)}</td><td><span class="${pmap[a.priority] || "pri-opt"}">${esc(a.priority)}</span></td><td style="font-family:monospace;font-size:11px;color:var(--muted2)">${esc(a.area)}</td><td>${esc(a.action)}</td><td class="rat">${esc(a.rationale)}</td></tr>`;
          })
          .join("");

  const CSS = `:root{--ink:#0a0e17;--surface:#111520;--surface2:#181e2e;--surface3:#1e2638;--border:#252d40;--border2:#2e3a52;--text:#d8e4f0;--muted:#5e7494;--muted2:#8fa3b8;--amber:#c9922a;--amber-dim:rgba(201,146,42,.12);--amber-glow:rgba(201,146,42,.06);--good:#4caf74;--warn:#d4a017;--bad:#e05c5c}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;background:var(--ink);color:var(--text);line-height:1.65;font-size:14px}
.shell{display:flex;min-height:100vh}
.sidenav{width:220px;flex-shrink:0;position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--border);padding:28px 0;display:flex;flex-direction:column}
.sidenav-logo{padding:0 20px 24px;border-bottom:1px solid var(--border);margin-bottom:16px}
.sidenav-logo-name{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
.sidenav-logo-sub{font-size:10px;color:var(--muted);margin-top:2px;font-family:monospace}
.nav-lbl{font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);padding:12px 20px 6px}
.nav-a{display:block;padding:7px 20px;font-size:12px;color:var(--muted2);text-decoration:none;border-left:2px solid transparent}
.nav-a:hover{color:var(--text);background:var(--surface2)}.nav-a.active{color:var(--amber);border-left-color:var(--amber);background:var(--amber-glow)}
.sidenav-footer{margin-top:auto;padding:16px 20px 0;border-top:1px solid var(--border);font-family:monospace;font-size:10px;color:var(--muted);line-height:1.8}
.main{flex:1;min-width:0;padding:0 48px 80px}
.rh{padding:52px 0 44px;border-bottom:1px solid var(--border);margin-bottom:48px}
.ey{font-family:monospace;font-size:11px;color:var(--amber);letter-spacing:.12em;text-transform:uppercase;margin-bottom:14px}
.rt{font-family:'DM Serif Display',serif;font-size:42px;line-height:1.15;margin-bottom:10px;font-weight:400}
.rti{color:var(--amber);font-style:italic}
.rm{font-size:13px;color:var(--muted2);margin-bottom:28px;font-family:monospace}
.chips{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:4px;font-size:12px;font-weight:600}
.dn{background:var(--amber-glow);border:1px solid rgba(201,146,42,.2);border-radius:6px;padding:11px 16px;font-size:12px;color:var(--muted2);font-family:monospace}
.dn strong{color:var(--amber)}
.sec{margin-bottom:56px;scroll-margin-top:24px}
.sh{margin-bottom:24px}
.se{font-family:monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.st{font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:var(--text);line-height:1.2}
.sd{margin-top:8px;font-size:13px;color:var(--muted2);max-width:680px}
.sdiv{width:40px;height:2px;background:var(--amber);margin:14px 0 0}
.mg{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mc{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px}
.ml{font-family:monospace;font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);margin-bottom:6px}
.mt{font-size:12px;color:var(--muted2);line-height:1.6}
.sb-scope{background:var(--amber-glow);border:1px solid rgba(201,146,42,.18);border-radius:8px;padding:14px 18px;font-size:12px;color:var(--muted2);margin-bottom:20px;line-height:1.7}
.sb-scope strong{color:var(--amber)}
.cp{display:grid;grid-template-columns:${ORGS.map(() => "1fr").join(" ")};gap:16px;margin-bottom:16px}
.op{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:20px}
.opn{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px}
.mch{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px}
.ch-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
.wbars{display:flex;gap:5px;align-items:flex-end;height:96px;margin-bottom:8px}
.tg{display:grid;grid-template-columns:${topicCols};border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px;font-size:12px}
.tgh{background:var(--surface3);padding:10px 14px;font-family:monospace;font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.tc{padding:12px 14px;border-bottom:1px solid var(--border);border-right:1px solid var(--border)}
.tc:nth-child(${ORGS.length + 1}n){border-right:none}
.tn{font-weight:600;color:var(--text);margin-bottom:3px}.cell-hl{font-size:11px;color:var(--muted);line-height:1.4;margin-top:5px}
.owns{background:rgba(76,175,116,.06)}.con{background:rgba(61,142,240,.04)}
.ob{display:inline-block;font-family:monospace;font-size:10px;font-weight:600;padding:1px 7px;border-radius:3px;margin-bottom:4px}
.badge-owns{background:rgba(76,175,116,.15);color:var(--good);border:1px solid rgba(76,175,116,.3)}
.badge-con{background:rgba(61,142,240,.1);color:#3d8ef0;border:1px solid rgba(61,142,240,.25)}
.badge-absent{background:var(--surface3);color:var(--muted);border:1px solid var(--border)}
.nt,.at,.apt{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
.nt th,.at th,.apt th{background:var(--surface3);padding:10px 14px;text-align:left;font-family:monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.nt td,.at td,.apt td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top}
.nt tr:hover td{background:var(--surface2)}
.pos-auth{display:inline-block;background:rgba(76,175,116,.12);color:var(--good);border:1px solid rgba(76,175,116,.3);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600}
.pos-per{display:inline-block;background:var(--surface3);color:var(--muted2);border:1px solid var(--border2);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600}
.pos-abs{display:inline-block;background:rgba(224,92,92,.1);color:var(--bad);border:1px solid rgba(224,92,92,.25);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600}
.ctag{display:inline-flex;font-family:monospace;font-size:10px;color:var(--amber);background:var(--amber-dim);border:1px solid rgba(201,146,42,.25);border-radius:3px;padding:1px 6px;cursor:pointer;text-decoration:none;vertical-align:middle;margin-left:4px}
.evd{display:none;background:var(--ink);border:1px solid var(--border2);border-radius:5px;padding:12px 14px;margin-top:9px}
.evd.open{display:block}
.ei{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start}
.ei:last-child{border:none;padding-bottom:0}
.en{font-family:monospace;font-size:10px;color:var(--muted);flex-shrink:0;min-width:40px;padding-top:2px}
.eq{font-family:monospace;font-size:11px;color:var(--text);line-height:1.6;background:var(--surface3);border-left:2px solid var(--amber);padding:5px 9px;border-radius:0 3px 3px 0;margin-bottom:4px}
.es{font-family:monospace;font-size:10px;color:var(--muted)}.es a{color:var(--amber);text-decoration:none}
.lc{font-family:monospace;font-size:10px;color:var(--warn);background:rgba(212,160,23,.1);border:1px solid rgba(212,160,23,.25);border-radius:3px;padding:2px 6px}
.cqp{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:18px}
.cqe{padding:8px 10px;border-radius:4px;margin-bottom:6px;font-size:11px;line-height:1.6}
.cqd{background:rgba(76,175,116,.07);border-left:2px solid var(--good)}
.cqv{background:var(--surface3);border-left:2px solid var(--muted)}
.cqet{font-family:monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.cqd .cqet{color:var(--good)}.cqv .cqet{color:var(--muted)}.cqetx{color:var(--text);font-family:monospace;font-size:11px}
.em-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:18px 20px;margin-bottom:12px}
.em-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;gap:12px}
.em-topic{font-size:14px;font-weight:600;color:var(--text)}
.em-mom{font-family:monospace;font-size:11px;color:var(--good);background:rgba(76,175,116,.1);border:1px solid rgba(76,175,116,.25);border-radius:3px;padding:2px 8px;flex-shrink:0}
.em-body{font-size:13px;color:var(--muted2);line-height:1.65;margin-bottom:10px}
.em-inf{background:rgba(212,160,23,.07);border:1px solid rgba(212,160,23,.2);border-radius:4px;padding:8px 12px;font-size:11px;color:var(--warn);font-family:monospace}
.em-inf::before{content:"⚠ INFERENCE — ";font-weight:600}
.em-src{font-size:11px;color:var(--muted);padding:3px 0;font-family:monospace;display:flex;gap:8px}
.em-src::before{content:"→";color:var(--amber)}
.scc{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:20px}
.sca{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:22px;text-align:center}
.scn{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}
.scg{font-family:'DM Serif Display',serif;font-size:44px;line-height:1;margin:8px 0 4px;font-weight:400}
#score table tbody tr{border-bottom:1px solid var(--border)}
#score table tbody tr:hover{background:var(--surface2)}
#score table td{padding:12px 12px}
#score table thead th{padding:10px 12px;background:var(--surface3)}
.scs{font-family:monospace;font-size:13px;color:var(--muted2);margin-bottom:14px}
.scf{background:var(--surface3);border:1px solid var(--border);border-radius:6px;padding:12px 16px;font-family:monospace;font-size:11px;color:var(--muted2);margin-top:8px}
.scf strong{color:var(--amber)}
.fc{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:20px 22px;display:flex;gap:18px;align-items:flex-start;margin-bottom:14px}
.fn{font-family:'DM Serif Display',serif;font-size:36px;color:var(--amber);line-height:1;flex-shrink:0;opacity:.45;margin-top:2px}
.fb{flex:1}.fh{font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;line-height:1.4}
.fd{font-size:13px;color:var(--muted2);line-height:1.65}
.pri-fix{display:inline-block;background:rgba(212,160,23,.12);color:var(--warn);border:1px solid rgba(212,160,23,.3);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600;white-space:nowrap}
.pri-lev{display:inline-block;background:rgba(76,175,116,.12);color:var(--good);border:1px solid rgba(76,175,116,.3);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600;white-space:nowrap}
.pri-opt{display:inline-block;background:rgba(61,142,240,.1);color:#3d8ef0;border:1px solid rgba(61,142,240,.25);border-radius:3px;padding:2px 8px;font-family:monospace;font-size:10px;font-weight:600;white-space:nowrap}
.pri-inv{display:inline-block;background:rgba(224,92,92,.1);color:var(--bad);border:1px solid rgba(224,92,92,.25);border-radius:3px;padding:2px 7px;font-family:monospace;font-size:10px;font-weight:600;white-space:nowrap}
.rat{font-size:11px;color:var(--muted);font-family:monospace;line-height:1.55}
.apt td{font-family:monospace;color:var(--muted2);font-size:11px}.apt td a{color:var(--amber);text-decoration:none}
.rf{border-top:1px solid var(--border);padding:28px 0 0;font-family:monospace;font-size:10px;color:var(--muted);line-height:2}
.edit-bar{position:fixed;top:14px;right:18px;z-index:2000;display:flex;gap:8px;align-items:center}
.edit-btn{background:#1e2638;border:1px solid var(--border2);border-radius:5px;padding:6px 13px;font-family:monospace;font-size:11px;color:var(--muted2);cursor:pointer;transition:all .15s;line-height:1.4}
.edit-btn:hover,.edit-btn.on{background:rgba(201,146,42,.15);border-color:rgba(201,146,42,.4);color:var(--amber)}
.edit-dl{color:var(--good)!important;border-color:rgba(76,175,116,.3)!important;background:rgba(76,175,116,.07)!important;display:none}
body.edit-mode .edit-dl{display:inline-block}
body.edit-mode [contenteditable="true"]:hover{outline:1.5px dashed rgba(201,146,42,.55);border-radius:2px;cursor:text}
body.edit-mode [contenteditable="true"]:focus{outline:1.5px solid rgba(201,146,42,.7);border-radius:2px}
.sec-x{display:none;position:absolute;top:10px;right:14px;width:22px;height:22px;border-radius:4px;background:rgba(224,92,92,.12);border:1px solid rgba(224,92,92,.3);color:var(--bad);font-size:15px;cursor:pointer;align-items:center;justify-content:center;line-height:1;font-weight:700}
.sec-x:hover{background:rgba(224,92,92,.28)}
body.edit-mode .sec-x{display:flex}
.sec.sec-hidden{display:none}
@media(max-width:900px){
  .sidenav{display:none}
  .main{padding:24px 20px 60px;max-width:100%}
  .rh{padding:32px 0 28px;margin-bottom:32px}
  .rt{font-size:28px}
  .st{font-size:22px}
  .sd{font-size:12px}
  .cp,.scc,.mg{grid-template-columns:1fr}
  .tg{grid-template-columns:1fr!important}
  .ch-hdr{flex-direction:column;gap:8px}
  .wbars{height:64px}
  .fc{flex-direction:column;gap:10px}
  .fn{font-size:26px}
  .em-hdr{flex-direction:column;gap:6px}
  .scg{font-size:32px}
  .edit-bar{top:8px;right:8px;gap:5px}
  .nt,.at,.apt{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  #score table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
}
@media(max-width:480px){
  .main{padding:16px 14px 60px}
  .rt{font-size:20px}
  .st{font-size:18px}
  .op{padding:14px 12px}
  .sec{margin-bottom:36px}
  .mch{padding:14px 12px}
  .em-card{padding:14px 16px}
  .scg{font-size:26px}
  .ey{font-size:9px;letter-spacing:.08em}
}
@media(max-width:380px){
  .main{padding:12px 10px 60px}
  .rt{font-size:17px}
  .st{font-size:16px}
  .chip{font-size:10px;padding:4px 8px}
  .rm,.sd{font-size:9px}
}
.mob-nav{display:none}
@media(max-width:900px){
  body{overflow-x:hidden}
  .shell{display:block!important}
  .mob-nav{display:flex;overflow-x:auto;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;padding:0;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .mob-nav::-webkit-scrollbar{display:none}
  .mob-nav a{padding:11px 14px;font-size:11px;font-weight:600;color:var(--muted2);text-decoration:none;white-space:nowrap;letter-spacing:.04em;flex-shrink:0;border-bottom:2px solid transparent}
  .mob-nav a:active{color:var(--amber);border-bottom-color:var(--amber)}
}
@media print{
  .sidenav,.edit-bar,.mob-nav{display:none!important}
  .main{padding:16px!important}
  .shell{display:block!important}
  body{overflow-x:visible!important}
  .sec{page-break-inside:avoid}
  a[href]:after{content:""}
}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AQ Intelligence &mdash; ${esc(ORGS.join(" vs "))}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="edit-bar" id="edit-bar"><button class="edit-btn" id="edit-btn" onclick="toggleEdit()">&#9998; Edit Mode</button><button class="edit-btn edit-dl" id="dl-btn" onclick="dlEdit()">&#8595; Download Edited</button></div>
<div class="shell">
<nav class="sidenav"><div class="sidenav-logo"><div class="sidenav-logo-name">Emerald AI</div><div class="sidenav-logo-sub">AQ Intelligence</div></div>
<div class="nav-lbl">Report</div><a href="#exec" class="nav-a active">Executive Summary</a>
<div class="nav-lbl">Press</div><a href="#sov" class="nav-a">Press Analytics</a><a href="#tv" class="nav-a">TV Coverage</a><a href="#momentum" class="nav-a">Momentum</a><a href="#topics" class="nav-a">Topic Ownership</a><a href="#appendix" class="nav-a">Citations</a><a href="#em" class="nav-a">White-Space Gaps</a><div class="nav-lbl">Social Media</div><a href="#social" class="nav-a">Social Media</a>
<div class="nav-lbl">LLM</div><a href="#aeo" class="nav-a">LLM Visibility</a>
<div class="nav-lbl">Conclusions</div><a href="#score" class="nav-a">Scorecard</a><a href="#actions" class="nav-a">Action Matrix</a>
<div class="sidenav-footer">Generated: ${new Date().toISOString().slice(0, 10)}<br>${navOrgs}CONFIDENTIAL<br><span style="display:inline-block;margin-top:6px;padding:4px 8px;background:rgba(212,160,23,.12);border:1px solid rgba(212,160,23,.3);border-radius:4px;color:var(--amber);font-weight:700">&#8377;${52 * ORGS.length}/month</span></div></nav>
<div class="mob-nav"><a href="#exec">Summary</a><a href="#sov">Press</a><a href="#tv">TV</a><a href="#momentum">Momentum</a><a href="#social">Social</a><a href="#aeo">LLM</a><a href="#score">Score</a><a href="#actions">Actions</a></div>
<main class="main">
<header class="rh" id="header"><div class="ey">Air Quality Media Intelligence &middot; India</div>
<h1 class="rt">Air Quality<br><span class="rti">Triple Media Analytics</span></h1>
<div class="rm">Period: ${esc(DATE_FROM)} &rarr; ${esc(DATE_TO)} &middot; ${now}</div>
<div class="chips">${orgChips}</div>
<div class="dn"><strong>Publicly available data</strong> Insight linked to evidence &middot; ${now}</div>
${pptxFilename ? `<div style="margin-top:16px;display:flex;align-items:center;gap:12px;background:rgba(61,142,240,.08);border:1px solid rgba(61,142,240,.25);border-radius:6px;padding:12px 16px;font-size:13px"><div style="flex:1;color:var(--text)"><strong style="font-weight:600">PowerPoint version available.</strong> Open the <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">.pptx</code> file in the same folder.</div><div style="font-family:monospace;font-size:11px;color:var(--muted2);flex-shrink:0">📁 ${esc(pptxFilename)}</div></div>` : ""}
</header>

<section class="sec" id="exec"><div class="sh"><div class="se">Section 01</div><h2 class="st">Executive Summary</h2><div class="sd">Headline comparative findings across ${ORGS.length} organisations — Press, LLM, and Social Media.</div><div class="sdiv"></div></div>
<div style="background:rgba(212,160,23,.07);border:1px solid rgba(212,160,23,.2);border-radius:8px;overflow:hidden;margin-bottom:4px">
<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;cursor:pointer;user-select:none" onclick="toggleExecDraft()">
<span style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--amber)">Draft Executive Summary <span style="font-weight:400;color:var(--muted2)">(AI-generated &mdash; review before sharing)</span></span>
<span id="exec-draft-icon" style="font-family:monospace;font-size:12px;color:var(--amber)">&#9660; Show draft</span>
</div>
<div id="exec-draft" style="display:none;padding:0 18px 18px">${execCards}</div>
</div>
<div style="margin-top:20px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:var(--muted2);line-height:1.7">
  <strong style="font-weight:600;letter-spacing:.04em">METHODOLOGY</strong> &mdash;
  Serper News API for media coverage &middot; Claude Sonnet 4.6 for article classification &middot;
  LLM probing (GPT-4o, Perplexity Sonar, Gemini 1.5 Flash) for AEO visibility &middot;
  Serper web search for Social Media presence (LinkedIn + X/Twitter) &middot;
  Articles filtered to 9 core outlets: TOI, HT, The Hindu, NDTV, News18, India Today, Aaj Tak, India TV, ABP News &middot;
  Only articles where the organisation is mentioned in scraped body text and classified as AQ-primary by Claude are included.
</div>
</section>
<section class="sec" id="sov"><div class="sh"><div class="se">Section 02a</div><h2 class="st">Press Analytics</h2><div class="sd">AQ article counts per org, deduplicated, date-filtered.</div><div class="sdiv"></div></div>
<div class="mch"><div class="ch-hdr"><div style="font-size:13px;font-weight:600;color:var(--text)">All AQ coverage &mdash; ${tot} articles</div><div style="font-size:11px;color:var(--muted2);margin-top:3px">${printTot} Print / Online &middot; ${tvTot} TV News</div></div>
${sovBar()}
<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted2);margin-bottom:10px">${ORGS.map((o, i) => `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${orgHex(i)};margin-right:5px"></span>${esc(o)}: ${data[o].total}</div>`).join("")}</div>
</div>
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Print / Online</div>
${sovByOrgTable()}
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-top:24px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">TV News</div>
${sovByOrgTVTable()}</section>

<section class="sec" id="tv"><div class="sh"><div class="se">Section 02b</div><h2 class="st">TV Channel Coverage</h2>
<div class="sd">AQ article mentions specifically in English TV (NDTV, News18, India Today) and Hindi TV (Aaj Tak, India TV, ABP News) channels.</div><div class="sdiv"></div></div>
<div style="margin-bottom:16px">
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">English TV</div>
<table class="nt"><thead><tr><th>Org</th>${TV_CHANNELS_ENGLISH.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
${ORGS.map((org, i) => `<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${TV_CHANNELS_ENGLISH.map((ch) => { const evArts = (arts[org] || []).filter(a => canonOutlet(a.source || '') === ch); const n = evArts.length; if (!n) return `<td style="font-family:monospace;color:var(--muted)">0</td>`; const uid = `tv_${org}_${ch}`.replace(/\W/g, '_'); const links = evArts.slice(0, 5).map(a => `<a href="${esc(a.url || '#')}" target="_blank" style="display:block;font-size:10px;color:var(--amber);text-decoration:none;margin-top:3px;line-height:1.4;white-space:normal;max-width:220px" title="${esc(a.title || '')}">${esc((a.title || '').length > 70 ? (a.title || '').slice(0, 70) + '…' : (a.title || ''))}</a>`).join(''); return `<td style="font-family:monospace"><strong>${n}</strong><br><span onclick="td('${uid}')" style="font-size:10px;color:var(--muted2);cursor:pointer;user-select:none">↗ sources</span><div id="${uid}" style="display:none">${links}</div></td>`; }).join("")}</tr>`).join("")}
</tbody></table></div>
<div>
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Hindi TV</div>
<table class="nt"><thead><tr><th>Org</th>${TV_CHANNELS_HINDI.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
${ORGS.map((org, i) => `<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${TV_CHANNELS_HINDI.map((ch) => { const evArts = (arts[org] || []).filter(a => canonOutlet(a.source || '') === ch); const n = evArts.length; if (!n) return `<td style="font-family:monospace;color:var(--muted)">0</td>`; const uid = `tv_${org}_${ch}`.replace(/\W/g, '_'); const links = evArts.slice(0, 5).map(a => `<a href="${esc(a.url || '#')}" target="_blank" style="font-size:10px;color:var(--amber);text-decoration:none;margin-top:3px;line-height:1.4;white-space:normal;max-width:220px;display:block" title="${esc(a.title || '')}">${esc((a.title || '').length > 70 ? (a.title || '').slice(0, 70) + '…' : (a.title || ''))}</a>`).join(''); return `<td style="font-family:monospace"><strong>${n}</strong><br><span onclick="td('${uid}')" style="font-size:10px;color:var(--muted2);cursor:pointer;user-select:none">↗ sources</span><div id="${uid}" style="display:none">${links}</div></td>`; }).join("")}</tr>`).join("")}
</tbody></table></div></section>

${momentumSection(arts, ORGS, DATE_FROM, DATE_TO, spikeAnnotations)}

<section class="sec" id="topics"><div class="sh"><div class="se">Section 03 &mdash; ${TOPICS.length} topics</div><h2 class="st">Topic Ownership Map</h2>
<div class="sd">Each article is classified into one of ${TOPICS.length} fixed AQ sub-topics by Claude Sonnet — used here because its larger context window and instruction-following accuracy consistently outperforms smaller models (GPT-4o mini, Gemini Flash) on nuanced Indian AQ sub-topic distinctions. Each cell shows article count and representative headlines. Position: <strong style="color:#4ade80">Leader</strong> (&ge;5 articles) &middot; <strong style="color:#fbbf24">Active</strong> (2&ndash;4 articles) &middot; <strong style="color:var(--muted)">Not Present</strong> (0&ndash;1).</div><div class="sdiv"></div></div>
${clsNotice}
${topicCards()}</section>

<section class="sec" id="appendix"><div class="sh"><div class="se">Section 05</div><h2 class="st">Citations</h2><div class="sd">All indexed articles from tracked outlets. Verify any claim by following the URL.</div><div class="sdiv"></div></div>
${appendixSections}</section>

<section class="sec" id="em"><div class="sh"><div class="se">Section 06</div><h2 class="st">Emerging Narratives</h2><div class="sd">Topics gaining traction in the <strong style="color:var(--text)">broader Indian AQ media landscape</strong> that the tracked organisations are <strong style="color:var(--warn)">not yet part of</strong> &mdash; identified by fetching general AQ news without org filters, removing articles that mention a tracked org, then clustering the remainder. These are emerging narrative opportunities: the conversation is active but your orgs are absent. <strong>Gap signal</strong> = evidence of the absence. <strong>Opportunity</strong> = a concrete action to enter the conversation.</div><div class="sdiv"></div></div>
${emergingCards}</section>

${SI.buildAEOHtml(aeoResults, ORGS, aeoQueriesUsed)}
<section class="sec" id="social"><div class="sh"><div class="se">Section 08</div><h2 class="st">Social Media Presence</h2><div class="sd">Live social data from official org handles — LinkedIn (LinkedIn API), X/Twitter (X API v2), Instagram (Graph API), and YouTube (Data API v3). ER = Engagement Rate. <strong style="color:var(--good)">✓ cit</strong> in the Citations section indicates the org appeared within 2 lines of an AQ keyword.</div><div class="sdiv"></div></div>
${socialERHtml}</section>

<section class="sec" id="score"><div class="sh"><div class="se">Section 09</div><h2 class="st">Competitive Scorecard</h2><div class="sd">Organisations ranked by weighted composite: Press · LLM · Social Media. YouTube ER and full social metrics appear in the <a href="#social" style="color:var(--amber);text-decoration:none">Social Media section ↑</a>.</div><div class="sdiv"></div></div>
${scorecards}</section>

<section class="sec" id="actions"><div class="sh"><div class="se">Section 10</div><h2 class="st">Action Matrix</h2><div class="sd">Data-anchored recommendations per org, including LLM and Social Media actions.</div><div class="sdiv"></div></div>
<table class="at"><thead><tr><th>Org</th><th>Priority</th><th>Area</th><th>Action</th><th>Data rationale</th></tr></thead><tbody>${actionRows}</tbody></table></section>

<footer class="rf">Generated by Emerald AI &middot; AQ Intelligence Platform v7 &middot; ${now}<br>
Data: Serper News API &middot; Claude Haiku 4.5 &middot; LLM probing &middot; ${tot} articles &middot; ${esc(DATE_FROM)} to ${esc(DATE_TO)} &middot; Orgs: ${esc(ORGS.join(", "))}<br>
<strong style="color:var(--text)">CONFIDENTIAL</strong> &mdash; prepared for ${esc(CLIENT_NAME || "client")}</footer>
</main></div>
<script>
function td(id){var e=document.getElementById(id);if(!e)return;if(e.classList.contains('evd')){e.classList.toggle('open');}else{e.style.display=e.style.display==='none'?'block':'none';}}
var secs=document.querySelectorAll('.sec[id],header[id]');
var nis=document.querySelectorAll('.nav-a');
secs.forEach(function(s){new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){nis.forEach(function(n){n.classList.remove('active');});var a=document.querySelector('.nav-a[href="#'+e.target.id+'"]');if(a)a.classList.add('active');}});},{threshold:0.25,rootMargin:'-10% 0px -60% 0px'}).observe(s);});
function toggleExecDraft(){var d=document.getElementById('exec-draft');var ic=document.getElementById('exec-draft-icon');if(!d)return;var open=d.style.display!=='none';d.style.display=open?'none':'block';if(ic)ic.textContent=open?'\\u25bc Show draft':'\\u25b2 Hide draft';}
function toggleEdit(){
  var on=!document.body.classList.contains('edit-mode');
  document.body.classList.toggle('edit-mode',on);
  var btn=document.getElementById('edit-btn');
  if(btn){btn.textContent=on?'\\u2715 Exit Edit':'\\u9998 Edit Mode';btn.classList.toggle('on',on);}
  document.querySelectorAll('.sd,.fd,.rat,.em-body,.em-inf,.eq,.cqetx').forEach(function(el){el.contentEditable=on?'true':'false';});
  if(on)addHideButtons();
}
function addHideButtons(){
  document.querySelectorAll('.sec[id],.rh[id]').forEach(function(s){
    if(s.querySelector('.sec-x'))return;
    var btn=document.createElement('button');
    btn.className='sec-x';btn.title='Hide section';btn.innerHTML='&times;';
    btn.onclick=function(){s.classList.add('sec-hidden');};
    s.style.position='relative';
    s.appendChild(btn);
  });
}
function dlEdit(){
  var bar=document.getElementById('edit-bar');
  var oldMode=document.body.classList.contains('edit-mode');
  document.body.classList.remove('edit-mode');
  document.querySelectorAll('.sd,.fd,.rat,.em-body,.em-inf,.eq,.cqetx').forEach(function(el){el.contentEditable='false';});
  if(bar)bar.style.display='none';
  var html='<!DOCTYPE html>'+document.documentElement.outerHTML;
  if(bar)bar.style.display='';
  if(oldMode)document.body.classList.add('edit-mode');
  var b=new Blob([html],{type:'text/html'});
  var a=document.createElement('a');a.href=URL.createObjectURL(b);
  a.download='aq-report-edited.html';a.click();URL.revokeObjectURL(a.href);
}
<\/script></body></html>`;
}

module.exports = { run };
