'use strict';
/**
 * Emerald AI — AEO + Social Intelligence Generator
 * pipeline/social-intelligence.js
 *
 * Generates the AEO and Social Intelligence sections of the AQ report.
 * Called from the main pipeline after news classification is done.
 *
 * Usage (from pipeline.js):
 *   const SI = require('./social-intelligence');
 *   const result = await SI.run(cfg, cb);
 *   // result.aeo        → { [org]: { score, llmBreakdown, topResponse } }
 *   // result.social     → { youtube, twitter, instagram, linkedin }
 *   // result.htmlBlocks → { aeoHtml, socialHtml }  ← inject into report
 *
 * Config keys used:
 *   cfg.ORGS            string[]  — org names to track
 *   cfg.DATE_FROM       string    — YYYY-MM-DD
 *   cfg.DATE_TO         string    — YYYY-MM-DD
 *   cfg.CLAUDE_KEY      string    — Anthropic API key
 *   cfg.SERPER_KEY      string    — Serper API key
 *   cfg.YOUTUBE_KEY?    string    — YouTube Data API v3 key (optional)
 *   cfg.OPENAI_KEY?     string    — OpenAI API key (optional, AEO)
 *   cfg.PERPLEXITY_KEY? string    — Perplexity API key (optional, AEO)
 *   cfg.GEMINI_KEY?     string    — Google Gemini API key (optional, AEO)
 */

const axios = require('axios');

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// The 5 AEO discovery questions asked to each LLM
const AEO_QUESTIONS = [
  'Which Indian research organisations are the most authoritative sources on air quality data and policy in India?',
  'What organisations publish the most reliable air quality index and PM2.5 data for Indian cities?',
  'Who are the leading think tanks and research bodies working on clean air policy in India?',
  'Which organisations should journalists cite when writing about India\'s National Clean Air Programme?',
  'What Indian NGOs or research institutes are most influential on air pollution solutions and technology?',
  'What research organisations in India are doing the most credible work on reducing vehicular air pollution?',
  'Which Indian institutes publish peer-reviewed studies on indoor air quality and household pollution?',
  'Who are the most cited Indian organisations in international climate and air quality policy discussions?',
  'What organisations should I follow for the latest data on India\'s air quality improvement progress?',
  'Which bodies produce the most reliable assessments of India\'s National Clean Air Programme targets?',
  'What Indian think tanks and research centres are leading the conversation on clean air finance and investment?',
  'Which organisations have the most credible data on PM2.5 health impacts in major Indian cities?',
  'Who are the key institutional voices on stubble burning and crop residue burning policy in India?',
  'What research organisations in India are tracking the health burden of air pollution most rigorously?',
  'Which Indian organisations are most frequently cited in government air quality policy consultations?'
];

// AQ terms required in a YouTube video title to pass the filter
const AQ_TITLE_TERMS = [
  'air quality','air pollution','aqi','pm2.5','pm10','smog','particulate',
  'clean air','ncap','grap','pollution index','haze','stubble burn','pollut'
];

// AQ terms for filtering social posts
const AQ_POST_TERMS = [
  'air quality','pollution','aqi','pm2.5','pm10','smog','particulate',
  'clean air','ncap','grap','emission','haze','dust','respiratory','breathing'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Utilities ──────────────────────────────────────────────────────────────
function isAQTitle(title) {
  const t = (title || '').toLowerCase();
  if (!AQ_TITLE_TERMS.some(term => t.includes(term))) return false;
  // Exclude off-topic AQ matches
  const exclude = ['noise pollution', 'water pollution', 'soil pollution', 'light pollution'];
  return !exclude.some(e => t.includes(e));
}

function isAQPost(text) {
  const t = (text || '').toLowerCase();
  return AQ_POST_TERMS.some(term => t.includes(term));
}

/** Detect where in content each org is mentioned: title, description, comments */
function detectMentionLocations(items, org) {
  const orgL = org.toLowerCase();
  const orgWords = orgL.split(/\s+/);
  const mentionsOrg = text => {
    const t = (text || '').toLowerCase();
    return t.includes(orgL) ||
      (orgWords.length > 1 && orgWords.every(w => t.includes(w)));
  };

  let title = 0, description = 0, comments = 0;
  for (const item of items) {
    if (mentionsOrg(item.title || item.hook || '')) title++;
    if (mentionsOrg(item.description || item.body || '')) description++;
    if ((item.comments || []).some(c => mentionsOrg(c.text || c))) comments++;
  }
  return { title, description, comments, total: title + description + comments };
}

function parseJ(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const si = s.search(/[\[{]/); if (si > 0) s = s.slice(si);
  const ei = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}')); if (ei > 0) s = s.slice(0, ei + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// ── API helpers ────────────────────────────────────────────────────────────
async function callClaude(prompt, key, maxTokens = 2000) {
  const res = await axios.post('https://api.anthropic.com/v1/messages',
    { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
  );
  return res.data.content[0].text;
}

async function serperSearch(query, key, type = 'news') {
  const endpoint = type === 'web' ? 'https://google.serper.dev/search' : 'https://google.serper.dev/news';
  const res = await axios.post(endpoint,
    { q: query, num: 20 },
    { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data.organic || res.data.news || [];
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 1: AEO PROBING
// ══════════════════════════════════════════════════════════════════════════
async function runAEO(cfg, orgs, cb) {
  const queriesUsed = (cfg.AEO_QUERIES && cfg.AEO_QUERIES.length > 0) ? cfg.AEO_QUERIES : AEO_QUESTIONS;
  const results = {};
  for (const org of orgs) {
    results[org] = { score: 0, mentions: 0, llmBreakdown: {}, topResponse: '', questionResults: {} };
    queriesUsed.forEach((_, i) => {
      results[org].questionResults[`Q${i + 1}`] = [];
    });
  }

  const hasAEO = cfg.OPENAI_KEY || cfg.PERPLEXITY_KEY || cfg.GEMINI_KEY;
  if (!hasAEO) {
    cb('  No LLM API keys provided — AEO score = 0', 'warn');
    return results;
  }

  // Run all 3 LLMs in parallel
  await Promise.allSettled([
    // OpenAI GPT-4o mini
    cfg.OPENAI_KEY && (async () => {
      cb(`  Probing OpenAI GPT-4o mini — ${queriesUsed.length} questions...`);
      const responses = await Promise.allSettled(
        queriesUsed.map(q =>
          axios.post('https://api.openai.com/v1/chat/completions',
            { model: 'gpt-4o-mini', max_tokens: 400, messages: [{ role: 'user', content: q }] },
            { headers: { 'Authorization': `Bearer ${cfg.OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      const texts = responses.map(r =>
        r.status === 'fulfilled' ? r.value.data.choices[0].message.content : ''
      );
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = text.toLowerCase().includes(org.toLowerCase());
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'GPT-4o', cited: mentioned });
        });
        results[org].llmBreakdown['GPT-4o mini'] = {
          mentions: count, total: queriesUsed.length,
          score: Math.min(count * 10, 100)
        };
        cb(`  GPT-4o → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })(),

    // Perplexity Sonar (all questions)
    cfg.PERPLEXITY_KEY && (async () => {
      cb(`  Probing Perplexity Sonar — ${queriesUsed.length} questions...`);
      const responses = await Promise.allSettled(
        queriesUsed.map(q =>
          axios.post('https://api.perplexity.ai/chat/completions',
            { model: 'sonar', max_tokens: 400, messages: [{ role: 'user', content: q }] },
            { headers: { 'Authorization': `Bearer ${cfg.PERPLEXITY_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      const texts = responses.map(r =>
        r.status === 'fulfilled' ? r.value.data.choices[0].message.content : ''
      );
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = text.toLowerCase().includes(org.toLowerCase());
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'Perplexity', cited: mentioned });
        });
        results[org].llmBreakdown['Perplexity'] = {
          mentions: count, total: queriesUsed.length,
          score: Math.min(count * 10, 100)
        };
        cb(`  Perplexity → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })(),

    // Gemini 1.5 Flash (all questions)
    cfg.GEMINI_KEY && (async () => {
      cb(`  Probing Gemini 1.5 Flash — ${queriesUsed.length} questions...`);
      const responses = await Promise.allSettled(
        queriesUsed.map(q =>
          axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.GEMINI_KEY}`,
            { contents: [{ parts: [{ text: q }] }], generationConfig: { maxOutputTokens: 400 } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      const texts = responses.map(r =>
        r.status === 'fulfilled'
          ? (r.value.data.candidates?.[0]?.content?.parts?.[0]?.text || '')
          : ''
      );
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = text.toLowerCase().includes(org.toLowerCase());
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'Gemini', cited: mentioned });
        });
        results[org].llmBreakdown['Gemini 1.5 Flash'] = {
          mentions: count, total: queriesUsed.length,
          score: Math.min(count * 10, 100)
        };
        cb(`  Gemini → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })()
  ].filter(Boolean));

  // Compute composite AEO score: 10 points per mention across all LLMs, capped at 100
  for (const org of orgs) {
    results[org].mentions = Object.values(results[org].llmBreakdown)
      .reduce((a, b) => a + b.mentions, 0);
    results[org].score = Math.min(results[org].mentions * 10, 100);
    cb(`  AEO score: ${org} = ${results[org].score}/100 (${results[org].mentions} mentions × 10pts)`, 'ok');
  }

  results._queriesUsed = queriesUsed;
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 2: YOUTUBE INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════
// ── YouTube OAuth helpers ─────────────────────────────────────────────────
const YT_TOKENS_FILE = require('path').join(__dirname, 'youtube_tokens.json');

function loadYtTokens() {
  try { return JSON.parse(require('fs').readFileSync(YT_TOKENS_FILE, 'utf8')); }
  catch { return null; }
}

async function getYtAccessToken(cfg) {
  const tokens = loadYtTokens();
  if (!tokens?.refresh_token) return null;

  // Refresh if expired (or no expiry recorded)
  const expiry = tokens.expiry_date || 0;
  if (Date.now() < expiry - 60000) return tokens.access_token;

  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        client_id:     cfg.YOUTUBE_CLIENT_ID,
        client_secret: cfg.YOUTUBE_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type:    'refresh_token'
      },
      timeout: 10000
    });
    const updated = {
      ...tokens,
      access_token: res.data.access_token,
      expiry_date:  Date.now() + (res.data.expires_in || 3600) * 1000
    };
    require('fs').writeFileSync(YT_TOKENS_FILE, JSON.stringify(updated, null, 2));
    return updated.access_token;
  } catch (e) {
    return null;
  }
}

async function runYouTube(cfg, orgs, cb) {
  if (!cfg.YOUTUBE_CLIENT_ID) {
    cb('  No YOUTUBE_CLIENT_ID — skipping YouTube', 'warn');
    return { videos: [], orgMentions: {}, trendingTopics: [], insightByOrg: {}, _connected: false };
  }

  const accessToken = await getYtAccessToken(cfg);
  if (!accessToken) {
    cb('  YouTube not authorised — visit /auth/youtube to complete one-time OAuth setup', 'warn');
    return { videos: [], orgMentions: {}, trendingTopics: [], insightByOrg: {}, _connected: false };
  }

  const authHeader = { Authorization: `Bearer ${accessToken}` };

  cb('  Fetching top AQ videos from YouTube...');
  const publishedAfter = new Date(cfg.DATE_FROM).toISOString();
  const publishedBefore = (() => { const d = new Date(cfg.DATE_TO); d.setHours(23, 59, 59); return d.toISOString(); })();

  const seen = new Set();
  const candidates = [];

  const queries = [
    'India air quality AQI pollution',
    'Delhi Mumbai air pollution smog',
    'India PM2.5 air pollution health',
    'India clean air NCAP GRAP policy',
    'India air quality research data 2026'
  ];

  for (const q of queries) {
    try {
      const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        headers: authHeader,
        params: {
          part: 'snippet', q, type: 'video',
          maxResults: 50, order: 'viewCount',
          publishedAfter, publishedBefore,
          relevanceLanguage: 'en', regionCode: 'IN'
        },
        timeout: 15000
      });
      for (const item of (res.data.items || [])) {
        const vid = item.id?.videoId;
        if (vid && !seen.has(vid)) { seen.add(vid); candidates.push(vid); }
      }
      await sleep(200);
    } catch (e) {
      cb(`  YouTube search error: ${e.response?.data?.error?.message || e.message}`, 'warn');
    }
  }

  // Fetch full details in batches of 50
  let details = [];
  for (let i = 0; i < candidates.length; i += 50) {
    try {
      const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        headers: authHeader,
        params: { part: 'snippet,statistics', id: candidates.slice(i, i + 50).join(',') },
        timeout: 15000
      });
      details = details.concat(res.data.items || []);
      await sleep(150);
    } catch (e) {
      cb(`  YouTube details error: ${e.message}`, 'warn');
    }
  }

  // Filter: AQ in title, exclude off-topic
  const aqVideos = details
    .filter(v => isAQTitle(v.snippet?.title || ''))
    .sort((a, b) => parseInt(b.statistics?.viewCount || 0) - parseInt(a.statistics?.viewCount || 0))
    .slice(0, 20); // top 20

  cb(`  ${aqVideos.length} videos pass AQ title filter (of ${details.length} fetched)`, 'ok');

  // Build structured items for mention detection
  const items = aqVideos.map(v => ({
    title: v.snippet?.title || '',
    hook: v.snippet?.title || '',
    description: (v.snippet?.description || '').slice(0, 400),
    comments: [], // comment fetching would be Step 2b — separate API call per video
    views: parseInt(v.statistics?.viewCount || 0),
    publishedAt: (v.snippet?.publishedAt || '').slice(0, 10),
    channel: v.snippet?.channelTitle || '',
    videoId: v.id
  }));

  // Detect org mentions
  const orgMentions = {};
  for (const org of orgs) {
    orgMentions[org] = detectMentionLocations(items, org);
  }

  // Use Claude to identify trending topics and generate insight
  const titlesText = items.slice(0, 20).map((v, i) => `${i + 1}. "${v.title}" — ${v.channel} (${v.views.toLocaleString()} views, ${v.publishedAt})`).join('\n');
  let trendingTopics = [], insightByOrg = {};

  try {
    cb('  Running Claude trend analysis on YouTube videos...');
    const prompt = `Analyse these top Indian AQ YouTube videos for the period. Identify:
1. The 5-7 main trending topics (as short pill labels, max 4 words each)
2. For each of these orgs [${orgs.join(', ')}], 1-2 sentences on their presence pattern — where they appear, what topics they dominate, what gaps exist
3. An overall summary sentence about what the YouTube AQ conversation was focused on this period

Return ONLY JSON:
{
  "trending_topics": ["topic 1", "topic 2", ...],
  "org_insights": {"${orgs[0]}": "...", "${orgs[1] || orgs[0]}": "..."},
  "platform_summary": "..."
}

VIDEOS:
${titlesText}`;

    const raw = await callClaude(prompt, cfg.CLAUDE_KEY, 1200);
    const parsed = parseJ(raw);
    if (parsed) {
      trendingTopics = parsed.trending_topics || [];
      insightByOrg = parsed.org_insights || {};
    }
  } catch (e) {
    cb(`  YouTube trend analysis error: ${e.message}`, 'warn');
  }

  return { videos: items, orgMentions, trendingTopics, insightByOrg, _connected: true };
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 3: SOCIAL MEDIA VIA SERPER (X, Instagram, LinkedIn)
// ══════════════════════════════════════════════════════════════════════════
async function runSocialPlatform(cfg, orgs, platform, cb) {
  // platform = { name, siteFilter, queries, maxPosts }
  cb(`  Fetching ${platform.name} posts via Serper...`);

  const seen = new Set();
  const posts = [];

  for (const q of platform.queries) {
    try {
      const results = await serperSearch(q, cfg.SERPER_KEY, 'web');
      for (const r of results) {
        const key = r.link || r.title;
        if (!seen.has(key) && isAQPost(`${r.title} ${r.snippet}`)) {
          seen.add(key);
          posts.push({
            title: r.title || '',
            hook: r.title || '',
            description: r.snippet || '',
            body: r.snippet || '',
            url: r.link || '',
            date: r.date || '',
            source: r.source || '',
            comments: [] // no comment fetch for Serper results
          });
        }
      }
      await sleep(300);
    } catch (e) {
      cb(`  ${platform.name} search error: ${e.message}`, 'warn');
    }
  }

  const topPosts = posts.slice(0, platform.maxPosts);
  cb(`  ${topPosts.length} ${platform.name} posts pass AQ filter`, 'ok');

  // Detect org mentions per post
  const orgMentions = {};
  for (const org of orgs) {
    orgMentions[org] = detectMentionLocations(topPosts, org);
  }

  // Claude insight
  const postsText = topPosts.slice(0, 20).map((p, i) =>
    `${i + 1}. "${p.title}" — ${p.source} (${p.date})\n   ${p.description.slice(0, 120)}`
  ).join('\n');

  let trendingTopics = [], insightByOrg = {};

  try {
    cb(`  Running Claude trend analysis on ${platform.name} posts...`);
    const prompt = `Analyse these top Indian AQ ${platform.name} posts. Identify:
1. The 5-7 main trending topics (short pill labels, max 4 words each)
2. For each of [${orgs.join(', ')}], 1-2 sentences on their presence and gaps
3. Platform-specific behaviour note (how citations differ from news media)

Return ONLY JSON:
{
  "trending_topics": ["..."],
  "org_insights": {"${orgs[0]}": "...", "${orgs[1] || orgs[0]}": "..."},
  "platform_note": "..."
}

POSTS:
${postsText}`;

    const raw = await callClaude(prompt, cfg.CLAUDE_KEY, 1000);
    const parsed = parseJ(raw);
    if (parsed) {
      trendingTopics = parsed.trending_topics || [];
      insightByOrg = parsed.org_insights || {};
    }
  } catch (e) {
    cb(`  ${platform.name} trend analysis error: ${e.message}`, 'warn');
  }

  return { posts: topPosts, orgMentions, trendingTopics, insightByOrg };
}

async function runSocial(cfg, orgs, cb) {
  const aqQuery = 'air quality India AQI pollution PM2.5';

  const [youtube, twitter, instagram, linkedin] = await Promise.allSettled([
    runYouTube(cfg, orgs, cb),
    runSocialPlatform(cfg, orgs, {
      name: 'X/Twitter', maxPosts: 20,
      queries: [
        `site:twitter.com OR site:x.com ${aqQuery}`,
        `site:twitter.com OR site:x.com "air pollution India" NCAP`,
        `site:twitter.com OR site:x.com "PM2.5" India AQI`
      ]
    }, cb),
    runSocialPlatform(cfg, orgs, {
      name: 'Instagram', maxPosts: 17,
      queries: [
        `site:instagram.com ${aqQuery}`,
        `site:instagram.com "air quality India" AQI`
      ]
    }, cb),
    runSocialPlatform(cfg, orgs, {
      name: 'LinkedIn', maxPosts: 18,
      queries: [
        `site:linkedin.com/posts ${aqQuery}`,
        `site:linkedin.com/posts "clean air India" NCAP policy`
      ]
    }, cb)
  ]);

  return {
    youtube:   youtube.status   === 'fulfilled' ? youtube.value   : null,
    twitter:   twitter.status   === 'fulfilled' ? twitter.value   : null,
    instagram: instagram.status === 'fulfilled' ? instagram.value : null,
    linkedin:  linkedin.status  === 'fulfilled' ? linkedin.value  : null
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 4: COMPUTE SOCIAL PRESENCE SCORE
// ══════════════════════════════════════════════════════════════════════════
function computeSocialScore(social, orgs) {
  const scores = {};
  for (const org of orgs) {
    scores[org] = {
      youtube:   social.youtube?.orgMentions?.[org]?.total   || 0,
      twitter:   social.twitter?.orgMentions?.[org]?.total   || 0,
      instagram: social.instagram?.orgMentions?.[org]?.total || 0,
      linkedin:  social.linkedin?.orgMentions?.[org]?.total  || 0,
      total: 0, normalised: 0
    };
    scores[org].total = scores[org].youtube + scores[org].twitter +
                        scores[org].instagram + scores[org].linkedin;
  }

  // Normalise 0–10 against max total
  const maxTotal = Math.max(...orgs.map(o => scores[o].total), 1);
  for (const org of orgs) {
    scores[org].normalised = Math.round(scores[org].total / maxTotal * 10);
  }

  return scores;
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 5: BUILD HTML BLOCKS
// ══════════════════════════════════════════════════════════════════════════

// Colour helpers
const ORG_COLORS = ['#3d8ef0','#e05c3a','#4caf74','#c9922a','#a371f7','#e05c5c','#14b8a6','#f97316','#8b5cf6','#06b6d4','#84cc16','#ef4444','#ec4899'];
const orgColor   = (org, orgs) => ORG_COLORS[orgs.indexOf(org) % ORG_COLORS.length] || '#8fa3b8';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the location mini-bars for a single org on a platform */
function locationBarsHtml(locs, color) {
  const max = Math.max(locs.title, locs.description, locs.comments, 1);
  const bar = (label, val) => `
    <div style="display:flex;align-items:center;gap:7px;padding:3px 0">
      <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5e7494;width:72px;text-transform:uppercase;letter-spacing:.06em;flex-shrink:0">${label}</span>
      <div style="flex:1;height:5px;background:#1e2638;border-radius:2px;overflow:hidden">
        <div style="height:100%;border-radius:2px;background:${color};width:${Math.round(val / max * 100)}%;opacity:${label === 'Title/Hook' ? 1 : label === 'Description' ? 0.7 : 0.5}"></div>
      </div>
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;width:18px;text-align:right;color:${label === 'Comments' ? '#5e7494' : color}">${val}</span>
    </div>`;
  return bar('Title/Hook', locs.title) + bar('Description', locs.description) + bar('Comments', locs.comments);
}

/** Build a 2-row table (one row per org) for a platform */
function platformNarrativeHtml(orgs, orgMentions, trendingTopics, insightByOrg, footnote) {
  const totalMentions = orgs.reduce((sum, org) => sum + (orgMentions[org]?.total || 0), 0);

  const topicChips = trendingTopics.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px">
        ${trendingTopics.map(t => `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8fa3b8;background:#1e2638;border:1px solid #2e3a52;border-radius:3px;padding:3px 10px">${escHtml(t)}</span>`).join('')}
      </div>`
    : '';

  let orgBlocks;
  if (totalMentions === 0) {
    const topicList = trendingTopics.slice(0, 5).join(' · ');
    const orgInsights = orgs.map(org => {
      const insight = insightByOrg[org];
      const col = orgColor(org, orgs);
      return insight
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #252d40"><strong style="color:${col}">${escHtml(org)}:</strong> ${escHtml(insight)}</div>`
        : '';
    }).filter(Boolean).join('');
    orgBlocks = `<div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px;font-size:13px;color:#8fa3b8;line-height:1.7">
      <div style="color:#5e7494;font-size:12px;margin-bottom:4px">No tracked organisations appeared in the content analysed on this platform.</div>
      ${topicList ? `<div style="font-size:12px;color:#8fa3b8;margin-bottom:2px">Conversation centred on: <span style="color:#d8e4f0">${escHtml(topicList)}</span></div>` : ''}
      ${orgInsights}
    </div>`;
  } else {
    orgBlocks = orgs.map(org => {
      const locs = orgMentions[org] || { title: 0, description: 0, comments: 0, total: 0 };
      const col = orgColor(org, orgs);
      const insight = insightByOrg[org] || '';
      if (locs.total === 0) {
        return `<div style="background:#111520;border:1px solid #252d40;border-left:2px solid #252d40;border-radius:0 6px 6px 0;padding:10px 14px;margin-bottom:8px;font-size:12px;color:#5e7494;line-height:1.6">
          <strong style="color:#5e7494">${escHtml(org)}</strong> — not mentioned in the content analysed on this platform.${insight ? ` ${escHtml(insight)}` : ''}
        </div>`;
      }
      const locBadges = [
        locs.title > 0 ? `<span style="font-size:9px;color:#8fa3b8;background:#252d40;border-radius:2px;padding:1px 6px;font-family:monospace">${locs.title} title</span>` : '',
        locs.description > 0 ? `<span style="font-size:9px;color:#8fa3b8;background:#252d40;border-radius:2px;padding:1px 6px;font-family:monospace">${locs.description} desc</span>` : '',
        locs.comments > 0 ? `<span style="font-size:9px;color:#8fa3b8;background:#252d40;border-radius:2px;padding:1px 6px;font-family:monospace">${locs.comments} comments</span>` : ''
      ].filter(Boolean).join(' ');
      return `<div style="background:#181e2e;border:1px solid #252d40;border-left:3px solid ${col};border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;padding:2px 9px;border-radius:3px;background:${col}1a;color:${col};border:1px solid ${col}55">${escHtml(org)}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:${col}">${locs.total} mention${locs.total !== 1 ? 's' : ''}</span>
          ${locBadges}
        </div>
        ${insight ? `<div style="font-size:13px;color:#8fa3b8;line-height:1.7">${escHtml(insight)}</div>` : ''}
      </div>`;
    }).join('');
  }

  return `${topicChips}${orgBlocks}
  <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494;margin-top:12px">${escHtml(footnote)}</div>`;
}

/** AEO section HTML */
function buildAEOHtml(aeoResults, orgs) {
  const orgColorList = ['#3d8ef0','#e05c3a','#4caf74','#c9922a','#a371f7','#e05c5c','#14b8a6','#f97316','#8b5cf6','#06b6d4','#84cc16','#ef4444','#ec4899'];

  function aeoGrade(score){
    if(score>=65)return{g:'S',label:'Sector Leader'};
    if(score>=45)return{g:'A',label:'Strong Visibility'};
    if(score>=28)return{g:'B',label:'Good Visibility'};
    if(score>=12)return{g:'C',label:'Developing'};
    if(score>=3) return{g:'D',label:'Limited'};
    return           {g:'E',label:'Not yet visible'};
  }
  function donutGrade(score, color){
    const {g} = aeoGrade(score);
    const da = (score / 100 * 163.4).toFixed(1);
    const db = (163.4 - da).toFixed(1);
    return `<svg width="64" height="64" viewBox="0 0 64 64" style="flex-shrink:0"><circle cx="32" cy="32" r="26" fill="none" stroke="#1e2638" stroke-width="10"/><circle cx="32" cy="32" r="26" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${da} ${db}" stroke-dashoffset="41" stroke-linecap="round"/><text x="32" y="38" text-anchor="middle" fill="${color}" font-size="18" font-family="Inter" font-weight="700">${g}</text></svg>`;
  }

  const orgPanels = orgs.map((org, oi) => {
    const col = orgColorList[oi % orgColorList.length];
    const d = aeoResults[org] || { score: 0, llmBreakdown: {}, topResponse: '', questionResults: {} };
    const pct = d.score;
    const grade = aeoGrade(pct);
    const isGood = pct >= 50;

    const llmRows = Object.entries(d.llmBreakdown).map(([llm, v]) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #252d40">
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8fa3b8;width:130px;flex-shrink:0">${escHtml(llm)}</span>
        <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
          <div style="height:100%;border-radius:3px;background:${col};width:${v.score}%"></div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:${col};width:38px;text-align:right">${v.mentions}/${v.total}</span>
      </div>`).join('');

    const noticeColor = isGood ? 'rgba(76,175,116,.06)' : 'rgba(224,92,92,.06)';
    const noticeBorder = isGood ? 'rgba(76,175,116,.2)' : 'rgba(224,92,92,.2)';
    const noticeTextCol = isGood ? '#4caf74' : '#e05c5c';
    const noticeText = isGood
      ? `<strong style="color:${noticeTextCol}">Consistent presence.</strong> ${escHtml(org)} cited in ${pct}% of LLM responses. Grade: ${grade.g} — ${grade.label}.`
      : `<strong style="color:${noticeTextCol}">Visibility gap.</strong> ${escHtml(org)} cited in only ${pct}% of LLM responses. Grade: ${grade.g} — ${grade.label}.`;

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:20px;border-top:2px solid ${col}">
      <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:14px">${escHtml(org)}</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        ${donutGrade(pct, col)}
        <div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:28px;line-height:1;font-weight:700;color:${col}">${grade.g} <span style="font-size:14px;color:#8fa3b8">(${pct}/100)</span></div>
          <div style="font-size:12px;color:#8fa3b8;margin-top:4px;margin-bottom:6px">AEO Score — ${grade.label}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">${d.mentions} of ${Object.values(d.llmBreakdown).reduce((a, b) => a + b.total, 0)} LLM responses cited ${escHtml(org)}</div>
        </div>
      </div>
      <div style="margin-bottom:12px">${llmRows || '<div style="font-size:11px;color:#5e7494">No LLM keys provided</div>'}</div>
      ${d.topResponse ? `
      <div style="background:#0a0e17;border:1px solid #2e3a52;border-left:2px solid #c9922a;border-radius:0 5px 5px 0;padding:10px 12px;margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#8fa3b8;line-height:1.65">
        <div style="font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c9922a;margin-bottom:5px">Example LLM response</div>
        &ldquo;${escHtml(d.topResponse)}&rdquo;
      </div>` : ''}
      <div style="background:${noticeColor};border:1px solid ${noticeBorder};border-radius:6px;padding:10px 14px;font-size:12px;color:#8fa3b8;margin-top:12px;line-height:1.6">${noticeText}</div>
    </div>`;
  }).join('');

  const queriesUsed = aeoResults._queriesUsed || AEO_QUESTIONS;
  const displayQueries = queriesUsed.slice(0, 5);
  const totalResponses = Object.values(Object.values(aeoResults).find(v => v && v.llmBreakdown) || {}).length > 0
    ? Object.values((Object.values(aeoResults).find(v => v && v.llmBreakdown) || {}).llmBreakdown || {}).reduce((s, v) => s + (v.total || 0), 0)
    : queriesUsed.length * 3;

  const qRows = displayQueries.map((q, qi) => {
    const badges = orgs.map(org => {
      const qKey = `Q${qi + 1}`;
      const qResults = aeoResults[org]?.questionResults?.[qKey] || [];
      const citedCount = qResults.filter(r => r.cited).length;
      const total = qResults.length;
      const col = total === 0 ? '#5e7494' : citedCount === total ? '#4caf74' : citedCount > 0 ? '#d4a017' : '#5e7494';
      const bg  = total === 0 ? '#1e2638' : citedCount === total ? 'rgba(76,175,116,.1)' : citedCount > 0 ? 'rgba(212,160,23,.1)' : '#1e2638';
      const bdr = total === 0 ? '#252d40' : citedCount === total ? 'rgba(76,175,116,.25)' : citedCount > 0 ? 'rgba(212,160,23,.25)' : '#252d40';
      const label = total === 0 ? `${org} —` : citedCount === total ? `${org} ✓ ${citedCount}/${total}` : citedCount > 0 ? `${org} ✓ ${citedCount}/${total}` : `${org} ✗ 0/${total}`;
      return `<span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:${col};background:${bg};border:1px solid ${bdr};border-radius:3px;padding:1px 6px">${escHtml(label)}</span>`;
    }).join('');
    return `
    <div style="display:flex;gap:14px;padding:9px 0;border-bottom:1px solid #252d40;align-items:flex-start;font-size:12px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#c9922a;flex-shrink:0;width:18px;padding-top:2px">Q${qi + 1}</span>
      <div style="color:#8fa3b8;flex:1;line-height:1.55">${escHtml(q)} <span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:8px">${badges}</span></div>
    </div>`;
  }).join('');

  return `
<section style="margin-bottom:56px;scroll-margin-top:24px" id="aeo">
  <div style="margin-bottom:24px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#5e7494;margin-bottom:6px">AEO — LLM Visibility</div>
    <h2 style="font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:#d8e4f0;line-height:1.2">AI Engine Optimisation</h2>
    <div style="margin-top:8px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65">When someone asks an AI model about Indian air quality, which organisations does it cite? ${queriesUsed.length} discovery questions were sent to three LLMs. Each mention = 10 points. Score out of 100. Contributes 30% of the Competitive Scorecard.</div>
    <div style="width:40px;height:2px;background:#c9922a;margin:14px 0 0"></div>
  </div>
  <div style="background:rgba(201,146,42,.06);border:1px solid rgba(201,146,42,.18);border-radius:8px;padding:14px 18px;font-size:12px;color:#8fa3b8;margin-bottom:20px;line-height:1.7">
    <strong style="color:#c9922a">How AEO is scored:</strong> ${queriesUsed.length} discovery questions sent to GPT-4o mini, Perplexity Sonar, and Gemini 1.5 Flash. Each response that names the organisation = <strong style="color:#c9922a">10 points</strong>. Maximum score = 100 (requires 10 or more mentions across all responses). Total possible responses per org = ${queriesUsed.length * 3}.
  </div>
  <div style="display:grid;grid-template-columns:repeat(${Math.min(orgs.length, 2)},1fr);gap:16px;margin-bottom:16px">${orgPanels}</div>
  <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px;margin-bottom:12px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#c9922a;margin-bottom:2px">Sample AEO Queries (first 5 of ${queriesUsed.length})</div>
    <div style="font-size:10px;color:#5e7494;margin-bottom:10px">These questions were sent to each LLM verbatim — no org names included.</div>
    ${qRows}
  </div>
  <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">GPT-4o mini · Perplexity Sonar · Gemini 1.5 Flash · ${queriesUsed.length} questions × 3 LLMs = ${queriesUsed.length * 3} responses per org · 10 pts per mention · max 100</div>
</section>`;
}

/** Social Intelligence section HTML */
function buildSocialHtml(social, socialScores, orgs) {
  const ytConnected = social.youtube?._connected !== false && (social.youtube?.videos?.length > 0 || social.youtube?.trendingTopics?.length > 0);

  const allPlatforms = [
    {
      id: 'yt', label: 'YouTube', data: social.youtube,
      icon: '▶', iconBg: '#ff4444',
      subtitle: 'YouTube Data API v3 · viewCount sort · regionCode=IN · AQ term required in title',
      srcBadge: 'YouTube Data API v3',
      footnote: `${social.youtube?.videos?.length || 0} videos analysed · 5 broad AQ search queries`,
      skip: !ytConnected
    },
    {
      id: 'tw', label: 'X / Twitter', data: social.twitter,
      icon: '𝕏', iconBg: '#111',
      subtitle: 'Serper Search · site:x.com · AQ + India queries · Google-indexed high-engagement posts',
      srcBadge: 'Serper Search API',
      footnote: `${social.twitter?.posts?.length || 0} posts analysed · Serper site:twitter.com search`,
      skip: false
    },
    {
      id: 'ig', label: 'Instagram', data: social.instagram,
      icon: '◉', iconBg: 'linear-gradient(135deg,#f09433,#dc2743,#bc1888)',
      subtitle: 'Serper Search · site:instagram.com · AQ queries · Google-indexed public posts',
      srcBadge: 'Serper Search API',
      footnote: `${social.instagram?.posts?.length || 0} posts analysed · public posts only`,
      skip: false
    },
    {
      id: 'li', label: 'LinkedIn', data: social.linkedin,
      icon: 'in', iconBg: '#0a66c2',
      subtitle: 'Serper Search · site:linkedin.com/posts · AQ queries · researcher & professional accounts',
      srcBadge: 'Serper Search API',
      footnote: `${social.linkedin?.posts?.length || 0} posts analysed · Serper site:linkedin.com/posts search`,
      skip: false
    }
  ];

  const platforms = allPlatforms.filter(p => !p.skip);

  const ytNotice = !ytConnected
    ? `<div style="background:rgba(212,160,23,.07);border:1px solid rgba(212,160,23,.2);border-radius:6px;padding:10px 14px;font-size:12px;color:#8fa3b8;margin-bottom:16px">
        <strong style="color:#d4a017">YouTube not connected.</strong> Visit <code style="background:#1e2638;padding:1px 5px;border-radius:3px">/auth/youtube</code> to complete one-time OAuth setup. YouTube data is excluded from this report.
      </div>` : '';

  const tabButtons = platforms.map((p, i) =>
    `<div class="si-tab${i === 0 ? ' si-tab-active' : ''}" onclick="siTab('${p.id}',this)" style="display:flex;align-items:center;gap:7px;padding:10px 18px;font-size:12px;font-weight:600;color:${i === 0 ? '#d8e4f0' : '#8fa3b8'};cursor:pointer;border-bottom:${i === 0 ? '2px solid #c9922a' : '2px solid transparent'};margin-bottom:-1px;transition:all .15s;user-select:none">
      <span style="width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:#fff;flex-shrink:0;background:${p.iconBg}">${p.icon}</span>
      ${escHtml(p.label)}
    </div>`
  ).join('');

  const tabPanes = platforms.map((p, i) => {
    const d = p.data || { videos: [], posts: [], orgMentions: {}, trendingTopics: [], insightByOrg: {} };
    const orgMentions = d.orgMentions || {};
    const topics = d.trendingTopics || [];
    const insights = d.insightByOrg || {};

    return `<div id="si-pane-${p.id}" style="display:${i === 0 ? 'block' : 'none'};padding-top:20px">
      <div style="display:flex;align-items:center;gap:12px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:12px 16px;margin-bottom:16px">
        <div style="width:34px;height:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#fff;flex-shrink:0;background:${p.iconBg}">${p.icon}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#d8e4f0">${escHtml(p.label)} — Top AQ Content · ${topics.length > 0 ? 'Data loaded' : 'Run pipeline to populate'}</div>
          <div style="font-size:11px;color:#8fa3b8;font-family:'JetBrains Mono',monospace;margin-top:2px">${escHtml(p.subtitle)}</div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#c9922a;background:rgba(201,146,42,.12);border:1px solid rgba(201,146,42,.25);border-radius:3px;padding:2px 8px;flex-shrink:0">${escHtml(p.srcBadge)}</span>
      </div>
      ${platformNarrativeHtml(orgs, orgMentions, topics, insights, p.footnote)}
    </div>`;
  }).join('');

  // Tally rows (only connected platforms)
  const tallyRows = platforms.map(p => {
    const icon = p.icon;
    const bg   = p.iconBg;
    const vals = orgs.map(org => {
      const k = p.id === 'yt' ? 'youtube' : p.id === 'tw' ? 'twitter' : p.id === 'ig' ? 'instagram' : 'linkedin';
      return { org, pts: socialScores[org]?.[k] || 0 };
    });
    const total = vals.reduce((s, v) => s + v.pts, 0);
    const bars = vals.map(({ org, pts }, oi) => {
      const col = ORG_COLORS[oi % ORG_COLORS.length];
      const pct = total > 0 ? (pts / total * 100).toFixed(0) : 0;
      return `<div style="height:100%;border-radius:2px;background:${col};width:${pct}%"></div>`;
    }).join('');
    const scores = vals.map(({ org, pts }, oi) =>
      `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:${ORG_COLORS[oi % ORG_COLORS.length]}">${escHtml(org)} ${pts}</span>`
    ).join(' &nbsp; ');

    return `<div style="display:flex;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid #252d40">
      <span style="display:flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#8fa3b8;width:110px;flex-shrink:0">
        <span style="width:14px;height:14px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#fff;background:${bg}">${icon}</span>
        ${escHtml(p.label)}
      </span>
      <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden;display:flex;gap:2px">${bars}</div>
      <div style="display:flex;gap:10px;flex-shrink:0">${scores}</div>
    </div>`;
  }).join('');

  const grandTotals = orgs.map((org, oi) => {
    const col = ORG_COLORS[oi % ORG_COLORS.length];
    const sc = socialScores[org] || {};
    return `<div style="text-align:center">
      <div style="font-family:'DM Serif Display',serif;font-size:44px;line-height:1;color:${col}">${sc.total || 0}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:${col};margin-top:2px">${escHtml(org)}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5e7494">${sc.normalised || 0}/10 normalised</div>
    </div>`;
  });

  const separators = grandTotals.flatMap((g, i) =>
    i < grandTotals.length - 1 ? [g, '<div style="width:1px;background:#252d40"></div>'] : [g]
  ).join('');

  return `
<section style="margin-bottom:56px;scroll-margin-top:24px" id="social">
  <div style="margin-bottom:24px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#5e7494;margin-bottom:6px">Social Intelligence</div>
    <h2 style="font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:#d8e4f0;line-height:1.2">Trending AQ Content Across Platforms</h2>
    <div style="margin-top:8px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65">Top AQ-related content on YouTube, X, Instagram, and LinkedIn — no org filter at search stage. Each time a tracked organisation is mentioned = 1 point. Points combine into the Social Presence Score.</div>
    <div style="width:40px;height:2px;background:#c9922a;margin:14px 0 0"></div>
  </div>
  <div style="background:rgba(201,146,42,.06);border:1px solid rgba(201,146,42,.18);border-radius:8px;padding:14px 18px;font-size:12px;color:#8fa3b8;margin-bottom:20px;line-height:1.7">
    <strong style="color:#c9922a">Scoring:</strong> 1 point per mention regardless of location. Location (Title/Hook · Description · Comments) is tracked separately — an org cited in a title drives far more discovery than one buried in comments.
  </div>

  ${ytNotice}
  <div style="display:flex;border-bottom:1px solid #252d40;margin-bottom:0">${tabButtons}</div>
  ${tabPanes}

  <!-- Tally -->
  <div style="margin-top:28px">
    <div style="font-size:13px;font-weight:600;color:#d8e4f0;margin-bottom:4px">Social Presence Score — All Platforms</div>
    <div style="font-size:12px;color:#8fa3b8;margin-bottom:16px">Each mention = 1 pt · tallied across all posts and videos · feeds into the Competitive Scorecard</div>
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:18px 20px">
      ${tallyRows}
      <div style="display:flex;gap:28px;padding:16px;background:#1e2638;border-radius:6px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:180px">
          <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:4px">Combined Social Presence Score</div>
          <div style="font-size:11px;color:#8fa3b8">4 platforms · each org mention = 1 pt · normalised 0–100 in Competitive Scorecard</div>
        </div>
        <div style="display:flex;gap:24px;flex-shrink:0;align-items:center">${separators}</div>
      </div>
    </div>
  </div>
</section>
<script>
function siTab(id,el){
  document.querySelectorAll('[id^="si-pane-"]').forEach(function(p){p.style.display='none';});
  document.querySelectorAll('.si-tab').forEach(function(t){t.style.color='#8fa3b8';t.style.borderBottom='2px solid transparent';});
  var pane=document.getElementById('si-pane-'+id);if(pane)pane.style.display='block';
  el.style.color='#d8e4f0';el.style.borderBottom='2px solid #c9922a';
}
<\/script>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  TREND SOCIAL INTELLIGENCE HTML
// ══════════════════════════════════════════════════════════════════════════
/**
 * buildTrendSocialHtml(trendEvent, trendSocialData, orgs)
 * Renders only when trendEvent.detected === true.
 */
function buildTrendSocialHtml(trendEvent, trendSocialData, orgs) {
  if (!trendEvent?.detected || !trendSocialData?.length) return '';

  const { topic, summary, triggeredAt, articleCount, orgsToFetch = [] } = trendEvent;
  const runDate = (triggeredAt || new Date().toISOString()).slice(0, 10);
  const notFlagged = (orgs || []).filter(o => !orgsToFetch.includes(o));

  function scoreBar(score, color) {
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
      <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;background:${color};width:${score * 10}%"></div>
      </div>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:${color};width:36px;text-align:right">${score}/10</span>
    </div>`;
  }

  function platformRow(label, icon, data, isYT) {
    const tdBase = 'padding:7px 10px;border-bottom:1px solid #252d40;vertical-align:top';
    if (isYT) {
      const v = data?.topVideo;
      return `<tr>
        <td style="${tdBase};font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494;white-space:nowrap">${icon} ${label}</td>
        <td style="${tdBase};font-family:'JetBrains Mono',monospace;font-size:11px;color:#8fa3b8;text-align:center">${data?.count || 0}</td>
        <td style="${tdBase};font-size:11px">${v ? `<a href="${escHtml(v.url)}" target="_blank" style="color:#c9922a;text-decoration:none">${escHtml(v.title)}</a>` : '<span style="color:#5e7494">—</span>'}</td>
        <td style="${tdBase};font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">${v ? `${(v.views||0).toLocaleString()} views · ${v.publishedAt}` : '—'}</td>
      </tr>`;
    }
    const r = data?.topResult;
    return `<tr>
      <td style="${tdBase};font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494;white-space:nowrap">${icon} ${label}</td>
      <td style="${tdBase};font-family:'JetBrains Mono',monospace;font-size:11px;color:#8fa3b8;text-align:center">${data?.count || 0}</td>
      <td style="${tdBase};font-size:11px">${r ? `<a href="${escHtml(r.url)}" target="_blank" style="color:#c9922a;text-decoration:none;font-size:10px;font-family:'JetBrains Mono',monospace">${escHtml((r.url||'').slice(0, 60))}…</a>` : '<span style="color:#5e7494">—</span>'}</td>
      <td style="${tdBase};font-size:10px;color:#8fa3b8;font-family:'JetBrains Mono',monospace;max-width:220px;overflow:hidden">${r ? escHtml((r.snippet || r.date || '').slice(0, 100)) : '—'}</td>
    </tr>`;
  }

  const orgCards = trendSocialData.map(entry => {
    const { org, trendRelevance, trendVisibilityScore: score, platforms } = entry;
    const col = orgColor(org, orgs);
    const isMentioned = trendRelevance === 'mentioned';
    const badgeCol = isMentioned ? '#4caf74' : '#c9922a';
    const badgeBg  = isMentioned ? 'rgba(76,175,116,.1)' : 'rgba(201,146,42,.1)';
    const badgeBdr = isMentioned ? 'rgba(76,175,116,.3)' : 'rgba(201,146,42,.3)';

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:18px 20px;border-top:2px solid ${col};margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:${col};letter-spacing:.1em;text-transform:uppercase">${escHtml(org)}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:${badgeCol};background:${badgeBg};border:1px solid ${badgeBdr};border-radius:3px;padding:2px 7px">${isMentioned ? 'Mentioned in news' : 'Implicated by topic'}</span>
        <span style="margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">Trend Visibility</span>
      </div>
      <div style="margin-bottom:14px">${scoreBar(score, col)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #252d40;border-radius:6px;overflow:hidden">
        <thead><tr style="background:#1e2638">
          <th style="padding:7px 10px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;border-bottom:1px solid #252d40;width:90px">Platform</th>
          <th style="padding:7px 10px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;border-bottom:1px solid #252d40;width:60px">Results</th>
          <th style="padding:7px 10px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;border-bottom:1px solid #252d40">Top Result</th>
          <th style="padding:7px 10px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;border-bottom:1px solid #252d40">Key Metric</th>
        </tr></thead>
        <tbody>
          ${platformRow('X/Twitter', '𝕏', platforms.x, false)}
          ${platformRow('YouTube', '▶', platforms.youtube, true)}
          ${platformRow('Instagram', '◉', platforms.instagram, false)}
          ${platformRow('LinkedIn', 'in', platforms.linkedin, false)}
        </tbody>
      </table>
    </div>`;
  }).join('');

  const gapBlock = notFlagged.length ? `
  <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:14px 18px;margin-top:8px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">Not flagged in this trend — social fetch not triggered</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${notFlagged.map(o => {
        const col = orgColor(o, orgs);
        return `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:${col};background:${col}18;border:1px solid ${col}44;border-radius:3px;padding:2px 8px">${escHtml(o)}</span>`;
      }).join('')}
    </div>
  </div>` : '';

  const savings = orgs.length > orgsToFetch.length
    ? Math.round((1 - orgsToFetch.length / orgs.length) * 100)
    : 0;

  return `
<section style="margin-bottom:56px;scroll-margin-top:24px" id="trend-social">
  <div style="margin-bottom:24px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#5e7494;margin-bottom:6px">Trend Social Intelligence</div>
    <h2 style="font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:#d8e4f0;line-height:1.2">Trend Social Intelligence</h2>
    <div style="margin-top:8px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65">
      Spike: <strong style="color:#c9922a">&ldquo;${escHtml(topic)}&rdquo;</strong> &middot; ${articleCount} articles in 48h &middot; ${runDate}
    </div>
    ${summary ? `<div style="margin-top:5px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65;font-style:italic">${escHtml(summary)}</div>` : ''}
    <div style="width:40px;height:2px;background:#c9922a;margin:14px 0 0"></div>
  </div>
  <div style="background:rgba(201,146,42,.06);border:1px solid rgba(201,146,42,.18);border-radius:8px;padding:14px 18px;font-size:12px;color:#8fa3b8;margin-bottom:20px;line-height:1.7">
    <strong style="color:#c9922a">How this works:</strong> A news spike was detected in the <strong style="color:#d8e4f0">${escHtml(topic)}</strong> topic.
    Social data was fetched only for the <strong style="color:#d8e4f0">${orgsToFetch.length}</strong> org${orgsToFetch.length !== 1 ? 's' : ''} mentioned or implicated
    — reducing API calls by <strong style="color:#4caf74">${savings}%</strong> compared to a full org sweep.
    Score (0–10): X/Twitter +3 · YouTube +3 · Instagram +2 · LinkedIn +2 · Mentioned in news +2.
  </div>
  ${orgCards}
  ${gapBlock}
</section>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN EXPORT
// ══════════════════════════════════════════════════════════════════════════
async function run(cfg, cb) {
  const orgs = cfg.ORGS || [];
  cb('\n=== Social Intelligence Module ===', 'head');

  // 1. AEO
  cb('\nSTEP A — AEO / LLM Visibility...', 'head');
  const aeo = await runAEO(cfg, orgs, cb);

  // 2. Social media
  cb('\nSTEP B — Social Media...', 'head');
  const social = await runSocial(cfg, orgs, cb);

  // 3. Score
  cb('\nSTEP C — Computing Social Presence Score...', 'head');
  const socialScores = computeSocialScore(social, orgs);
  for (const org of orgs) {
    cb(`  ${org}: ${socialScores[org].total} pts total (${socialScores[org].normalised}/100 normalised)`, 'ok');
  }

  // 4. Build HTML
  cb('\nSTEP D — Building HTML sections...', 'head');
  const aeoHtml    = buildAEOHtml(aeo, orgs);
  const socialHtml = buildSocialHtml(social, socialScores, orgs);
  cb('  HTML blocks built', 'ok');

  return { aeo, social, socialScores, htmlBlocks: { aeoHtml, socialHtml } };
}

module.exports = { run, runAEO, runYouTube, runSocial, computeSocialScore, buildAEOHtml, buildSocialHtml, buildTrendSocialHtml };
