"use strict";
/**
 * claude-client.js — Claude API client + JSON-response parsing, extracted
 * from pipeline.js so LangGraph graph modules can call Claude without a
 * circular require back into pipeline.js (which requires the graphs).
 *
 * costTracker is shared beyond just Claude calls — pipeline.js's Serper
 * functions also increment costTracker.serperQueries — kept here since
 * callClaude was its original owner; pipeline.js imports the same object
 * by reference to keep incrementing it from serperSearch/serperScrape.
 */

const axios = require("axios");

// Shared usage counters for one pipeline run. pipeline.js resets these at the
// top of run() and reads them back at the end to compute the real API cost of
// the report (emailed to the admin). Every collector imports this same object
// by reference and increments its own line.
const costTracker = {
  serperQueries: 0,        // Serper /news + /scrape calls        ($0.001 each)
  claudeInputTokens: 0,    // Anthropic input tokens (metered)    ($1 / 1M)
  claudeOutputTokens: 0,   // Anthropic output tokens (metered)   ($5 / 1M)
  firecrawlSearches: 0,    // Firecrawl /v2/search (news+scrape)   (~$0.05 each)
  apidirectCalls: 0,       // APIdirect.io endpoint calls         ($0.01 each)
  youtubeApiCalls: 0,      // YouTube Data API v3 requests        (quota, ~free)
  perplexityCalls: 0,      // Perplexity sonar AEO probes         ($0.001 each)
  openaiCalls: 0,          // OpenAI gpt-4o-mini AEO probes       ($0.0003 each)
  geminiCalls: 0,          // Gemini flash AEO probes             (~free tier)
  claudeAeoCalls: 0,       // Claude Haiku AEO probes (~300 tok)  ($0.0006 each)
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
      timeout: 600000,
    },
  );
  const usage = res.data.usage;
  if (usage) {
    costTracker.claudeInputTokens += usage.input_tokens || 0;
    costTracker.claudeOutputTokens += usage.output_tokens || 0;
  }
  return res.data.content[0].text;
}

module.exports = {
  callClaude,
  parseJ,
  extractJsonArray,
  CLAUDE_MODEL,
  CLAUDE_CLASSIFY_MODEL,
  costTracker,
};
