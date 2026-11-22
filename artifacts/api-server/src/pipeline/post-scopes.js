"use strict";
/**
 * post-scopes.js — every social post of a period, each put in ONE scope.
 *
 * The weekly collection already holds every post an organisation published in the period (the keyword test only decides what
 * is COUNTED, it does not discard the rest). This module takes all of them, and labels each with the one scope its subject
 * belongs to: air quality, climate, sustainability, or other. The label is made by the Claude CLI (never the API), in batches.
 *
 *   collectPosts(socialERResults, from, to)  → the posts, one record each (organisation, platform, text, date, engagement)
 *   labelPosts(posts, { askClaude, cache })  → the same posts with `scope` set; a batch that fails is left UNLABELLED
 *                                              (scope null), never guessed
 *   buildDataset(...)                        → the file the Interactive tab reads
 */

const SCOPES = [
  { id: "air-quality", label: "Air quality", code: "AQ", rule: "air quality, air pollution, smog, PM2.5/PM10, emissions that pollute the air, clean-air policy, environmental health effects of polluted air, in India or elsewhere" },
  { id: "climate", label: "Climate", code: "CL", rule: "climate change, global warming, greenhouse-gas emissions, heat waves, extreme weather, climate impacts, adaptation, mitigation, climate policy or finance" },
  { id: "sustainability", label: "Sustainability", code: "SU", rule: "sustainability and sustainable development (SDGs), ESG and sustainable finance, circular economy, waste, water, biodiversity, land, the energy transition, sustainable cities and mobility" },
  { id: "other", label: "Other", code: "OT", rule: "none of the above: events, hiring, greetings and festival wishes, awards, organisation news, and anything not mainly about those subjects" },
];
const BY_CODE = Object.fromEntries(SCOPES.map((s) => [s.code, s.id]));

// The words each subject's weekly report uses to find its posts (the framework's scope keywords and post-filter terms). They are
// SHOWN to the client for transparency; they do not decide a post's scope — the label reads the post for its main subject.
const FRAMEWORK_OF = { "air-quality": "air-quality", climate: "climate", sustainability: "sustainability" };
function scopeKeywords(id) {
  if (!FRAMEWORK_OF[id]) return [];
  const fw = require("./frameworks").getFramework(FRAMEWORK_OF[id]);
  const seen = new Set(), out = [];
  for (const k of [...(fw.defaultScope || []), ...(fw.postFilterTerms || [])]) {
    const t = String(k).trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

const PLATFORMS = { li: "LinkedIn", x: "X", ig: "Instagram" };

const day = (d) => String(d || "").slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();

/**
 * The posts of the period from the saved social results, one record per post:
 * { id, org, platform, url, text, date, likes, comments, shares, views }. Retweets are left out (they are not the
 * organisation's own post); a post returned twice is kept once; on LinkedIn the same message posted several times with the
 * same engagement (a repost pattern the data source returns) is kept once.
 */
function collectPosts(socialERResults, from, to) {
  const posts = [];
  const inWin = (d) => { const t = day(d); return t >= from && t <= to; };
  for (const r of socialERResults || []) {
    const org = r.org;
    const seen = new Set(), seenMsg = new Set();
    const add = (platform, p, text, extra) => {
      if (!p || !inWin(p.date)) return;
      const url = p.url || "";
      const key = url || `${p.date}|${text.slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (platform === "li") {
        const mk = `${text}|${num(p.likes)}|${num(p.comments)}|${num(p.shares)}`;
        if (seenMsg.has(mk)) return;
        seenMsg.add(mk);
      }
      posts.push({ id: `${platform}:${url || key}`, org, platform, url, text, date: String(p.date).slice(0, 19), ...extra });
    };
    for (const p of (r.liData && r.liData.rawPosts) || []) add("li", p, clean(p.text), { likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), views: 0 });
    for (const p of (r.twData && r.twData.rawTweets) || []) {
      if (String(p.is_retweet).toLowerCase() === "true") continue;
      add("x", p, clean(p.text), { likes: num(p.likes), comments: num(p.replies), shares: num(p.retweets), views: num(p.views) });
    }
    for (const p of (r.igData && r.igData.rawPosts) || []) add("ig", p, clean(p.snippet || p.text), { likes: num(p.likes), comments: num(p.comments), shares: 0, views: num(p.views) });
  }
  return posts.sort((a, b) => (a.org === b.org ? b.date.localeCompare(a.date) : a.org.localeCompare(b.org)));
}

const SYSTEM = "You are a careful analyst who sorts social media posts by subject. Follow the instructions exactly and reply with only the JSON asked for.";

function batchPrompt(batch) {
  const defs = SCOPES.map((s) => `${s.code} = ${s.label}: ${s.rule}`).join("\n");
  const list = batch.map((p, i) => `[${i}] (${PLATFORMS[p.platform]}, ${p.org}) ${p.text.slice(0, 600) || "(no text)"}`).join("\n");
  return `Sort each social media post below into exactly ONE scope, by what the post is MAINLY about.

SCOPES
${defs}

RULES
- Choose by the post's main subject. A passing mention does not count: a greeting that says "clean air", a hiring notice, an event thanks list, or a newsletter whose items are many subjects is OT unless one subject clearly leads it.
- If a post is about two subjects, pick the one it leads with.
- Posts in any language are allowed; judge by meaning.
- Every post gets one code: AQ, CL, SU or OT.

POSTS
${list}

Reply with ONLY a JSON array with one entry per post, in this form: [{"i":0,"s":"AQ"},{"i":1,"s":"OT"}]`;
}

/** The labels in a model reply, as { index: scopeId }. Entries that are not a valid index and code are ignored. */
function parseLabels(reply, size) {
  const m = /\[[\s\S]*\]/.exec(String(reply || ""));
  if (!m) return {};
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return {}; }
  const out = {};
  for (const e of Array.isArray(arr) ? arr : []) {
    const i = Number(e && e.i), id = BY_CODE[String(e && e.s).toUpperCase()];
    if (Number.isInteger(i) && i >= 0 && i < size && id) out[i] = id;
  }
  return out;
}

/**
 * Label the posts. `cache` ({ postId: scopeId }) is used first and filled in: a post already labelled is not asked again, so a
 * second run on the same week costs nothing. A batch whose reply misses some posts is asked once more for just those; posts
 * still without a label keep scope null and the dataset says how many (nothing is guessed).
 */
async function labelPosts(posts, { askClaude, cache = {}, batchSize = 30, model = process.env.SCOPE_CLAUDE_MODEL || "sonnet", log = () => {} }) {
  const todo = posts.filter((p) => !cache[p.id]);
  const batches = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let done = 0;
  await Promise.all(batches.map(async (batch) => {
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      let labels = {};
      try { labels = parseLabels(await askClaude(batchPrompt(pending), { model, system: SYSTEM }), pending.length); }
      catch (e) { log(`  scope labelling: a batch failed (${String(e.message).split("\n")[0]})`); }
      const rest = [];
      pending.forEach((p, i) => { if (labels[i]) cache[p.id] = labels[i]; else rest.push(p); });
      pending = rest;
    }
    done += batch.length;
    log(`  scope labelling: ${done}/${todo.length} posts`);
  }));
  for (const p of posts) p.scope = cache[p.id] || null;
  return posts;
}

/** The file the Interactive tab reads. */
function buildDataset({ posts, from, to, framework, orgs, reportName, generatedAt }) {
  const unlabelled = posts.filter((p) => !p.scope).length;
  return {
    version: 1,
    report: reportName || null,
    framework: framework || "all",
    dateFrom: from, dateTo: to,
    generatedAt: generatedAt || new Date().toISOString(),
    scopes: SCOPES.map((s) => ({ id: s.id, label: s.label })),
    // how the scopes are defined, for the client: the rule each is sorted by and the subject's keywords
    scopeInfo: SCOPES.map((s) => ({ id: s.id, label: s.label, rule: s.rule, keywords: scopeKeywords(s.id) })),
    orgs: orgs || [...new Set(posts.map((p) => p.org))].sort(),
    unlabelled,
    // short keys keep the file small; the UI knows them: o=org, p=platform, s=scope, d=date, t=text, u=url, l=likes, c=comments, h=shares, v=views
    posts: posts.map((p) => ({ o: p.org, p: p.platform, s: p.scope, d: p.date, t: p.text.slice(0, 400), u: p.url, l: p.likes, c: p.comments, h: p.shares, v: p.views })),
  };
}

module.exports = { SCOPES, PLATFORMS, collectPosts, labelPosts, parseLabels, batchPrompt, buildDataset };
