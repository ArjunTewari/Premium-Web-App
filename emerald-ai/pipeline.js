'use strict';
/**
 * Emerald AI — AQ Intelligence Pipeline
 * Called by index.js with a config object. Streams log lines via cb().
 */

const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const PptxGen = require('pptxgenjs');
const SI      = require('./social-intelligence');
const TS      = require('./trend-social');

const OUTLETS = [
  'Times of India','Hindustan Times','The Hindu','Indian Express','Business Standard',
  'The Print','Scroll','Deccan Herald',
  'NDTV','News18','India Today',
  'Aaj Tak','India TV','ABP News'
];
const TV_CHANNELS_ENGLISH = ['NDTV','News18','India Today'];
const TV_CHANNELS_HINDI   = ['Aaj Tak','India TV','ABP News'];
const ALL_TV_CHANNELS     = [...TV_CHANNELS_ENGLISH, ...TV_CHANNELS_HINDI];
const TOPICS = [
  'NCAP','Policy','PM2.5 Exposure','Stubble Burning','Clean Air Finance',
  'Vehicular Pollution','Health Impact','Industrial Pollution','Heat-AQI',
  'Brick Kilns','Petrol Emissions','Diesel Emissions','Super Emitters',
  'Thermal Power Plants','Household Pollution','Indoor Pollution',
  'Biomass Air Pollution','Rice Residue Burning','Wheat Residue Burning','Road Dust'
];
// 13 visually distinct colours — one per org slot
const ORG_COLORS_HEX = ['3d8ef0','e05c3a','4caf74','c9922a','a371f7','e05c5c','14b8a6','f97316','8b5cf6','06b6d4','84cc16','ef4444','ec4899'];
const orgHex  = i => '#' + ORG_COLORS_HEX[i % ORG_COLORS_HEX.length];
const orgPptx = i => ORG_COLORS_HEX[i % ORG_COLORS_HEX.length];

// AQ questions asked to each LLM for AEO scoring
// Intentionally generic — no org names — so mentions in responses are fully organic
const AEO_QUESTIONS = [
  'What does the latest research say about PM2.5 health impacts in Indian cities?',
  'How effective has India\'s National Clean Air Programme been so far, and what does the evidence show?',
  'What are the main sources of air pollution in Indian cities and what data exists on their relative contribution?',
  'What are the most trusted data sources for monitoring air quality across Indian cities?',
  'What scientific evidence exists on the health burden of air pollution in India?',
  'What policy interventions have been most effective at reducing air pollution in Indian cities?',
  'How is coal-based power generation contributing to air quality problems in India?',
  'What is known about seasonal air quality patterns in North India — what drives the winter smog?',
  'How do Indian cities compare on air quality improvement, and which approaches are working best?',
  'What are the key gaps in India\'s air quality monitoring and reporting infrastructure?',
  'What role do Indian think tanks and research organisations play in shaping clean air policy?',
  'Which organisations are most active in advocating for stricter air quality standards in India?',
  'What is the current scientific consensus on crop residue burning and its contribution to North India AQ?',
  'How is India\'s electric vehicle transition contributing to improvements in urban air quality?',
  'What are the most significant emerging air pollution sources in Indian cities that need attention?'
];

// ── Utilities ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc   = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const dom   = url => { try { return new URL(url).hostname.replace('www.','').split('.')[0]; } catch { return ''; } };

function parseJ(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  const si = s.search(/[\[{]/); if (si > 0) s = s.slice(si);
  const ei = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}')); if (ei > 0) s = s.slice(0, ei+1);
  try { return JSON.parse(s); } catch { return null; }
}

function parseDateStr(s) {
  if (!s) return null;
  const now = new Date();
  const ago = s.match(/(\d+)\s*(day|week|month|year)/i);
  if (ago) {
    const n=parseInt(ago[1]),u=ago[2][0].toLowerCase(),d=new Date(now);
    if(u==='d')d.setDate(d.getDate()-n);
    else if(u==='w')d.setDate(d.getDate()-n*7);
    else if(u==='m')d.setMonth(d.getMonth()-n);
    else d.setFullYear(d.getFullYear()-n);
    return d;
  }
  const mo={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const m1=s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if(m1){const mv=mo[m1[1].toLowerCase().slice(0,3)];if(mv!=null)return new Date(parseInt(m1[3]),mv,parseInt(m1[2]));}
  const iso=s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(iso)return new Date(parseInt(iso[1]),parseInt(iso[2])-1,parseInt(iso[3]));
  return null;
}

// ── Classification helpers ─────────────────────────────────────────────────
/** Count exact-phrase occurrences of org name (case-insensitive) in scraped text */
function countMentions(text, org) {
  if (!text || !org) return 0;
  const escaped = org.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.toLowerCase().match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

/** Return a ~windowSize window of text centered on the first occurrence of org.
 *  If org is not found, returns first windowSize chars (caller should check countMentions). */
function extractRelevantWindow(text, org, windowSize = 700) {
  if (!text) return '';
  const escaped = org.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idx = text.toLowerCase().search(new RegExp(escaped));
  if (idx === -1) return text.slice(0, windowSize);
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, idx - half);
  let end   = Math.min(text.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
}

function canonOutlet(src) {
  if(!src) return null; const s=src.toLowerCase();
  if(s.includes('times of india')||s.includes('timesofindia')||s.includes('indiatimes'))return 'Times of India';
  if(s.includes('hindustan times')||s.includes('hindustantimes'))return 'Hindustan Times';
  if(s.includes('the hindu')||s.includes('thehindu'))return 'The Hindu';
  if(s.includes('india today')||s.includes('indiatoday'))return 'India Today';
  if(s.includes('ndtv'))return 'NDTV';
  if(s.includes('news18'))return 'News18';
  if(s.includes('the print')||s.includes('theprint'))return 'The Print';
  if(s.includes('scroll'))return 'Scroll';
  if(s.includes('indian express')||s.includes('indianexpress'))return 'Indian E xpress';
  if(s.includes('business standard')||s.includes('bsind'))return 'Business Standard';
  if(s.includes('deccan herald')||s.includes('deccanherald'))return 'Deccan Herald';
  if(s.includes('aaj tak')||s.includes('aajtak'))return 'Aaj Tak';
  if(s.includes('india tv')||s.includes('indiatv'))return 'India TV';
  if(s.includes('abp news')||s.includes('abplive'))return 'ABP News';
  return null;
}

// ── API calls ──────────────────────────────────────────────────────────────
async function serperSearch(query, key) {
  const res = await axios.post('https://google.serper.dev/news',
    { q: query, num: 10 },
    { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data.news || res.data.organic || [];
}

async function serperScrape(url, key) {
  try {
    const res = await axios.post('https://scrape.serper.dev', { url },
      { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, timeout: 15000 });
    return ((res.data.text||res.data.content||'')).replace(/\s+/g,' ').trim().slice(0,2000);
  } catch { return ''; }
}

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

async function callClaude(prompt, key, maxTokens=2500) {
  const res = await axios.post('https://api.anthropic.com/v1/messages',
    { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role:'user', content:prompt }] },
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
  );
  return res.data.content[0].text;
}

// ── AEO: Query LLMs and score org mentions ─────────────────────────────────
async function probeAEO(cfg, orgs, cb) {
  const results = {};
  for (const org of orgs) {
    results[org] = { score: 0, mentions: 0, llmBreakdown: {}, topResponse: '' };
  }

  // OpenAI — run all 5 questions in parallel for speed
  if (cfg.OPENAI_KEY) {
    cb(`  Probing OpenAI (GPT-4o mini) — ${AEO_QUESTIONS.length} questions in parallel...`);
    let totalMentions = {}; orgs.forEach(o => totalMentions[o] = 0);
    const responses = await Promise.allSettled(AEO_QUESTIONS.map(q =>
      axios.post('https://api.openai.com/v1/chat/completions',
        { model: 'gpt-4o-mini', max_tokens: 400, messages: [{ role:'user', content: q }] },
        { headers: { 'Authorization': `Bearer ${cfg.OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      )
    ));
    for (const r of responses) {
      if (r.status !== 'fulfilled') { cb(`  OpenAI question error: ${r.reason?.message}`, 'warn'); continue; }
      const text = r.value.data.choices[0].message.content;
      for (const org of orgs) {
        if (text.toLowerCase().includes(org.toLowerCase())) {
          totalMentions[org]++;
          if (!results[org].topResponse) results[org].topResponse = text.slice(0,200);
        }
      }
    }
    for (const org of orgs) {
      const score = Math.round(totalMentions[org] / AEO_QUESTIONS.length * 100);
      results[org].llmBreakdown['OpenAI GPT-4o'] = { mentions: totalMentions[org], score };
      cb(`  OpenAI — ${org}: ${totalMentions[org]}/${AEO_QUESTIONS.length} mentions`, totalMentions[org] > 0 ? 'ok' : 'warn');
    }
  }

  // Perplexity — 3 questions in parallel (save credits)
  if (cfg.PERPLEXITY_KEY) {
    cb(`  Probing Perplexity (sonar) — 3 questions in parallel...`);
    let totalMentions = {}; orgs.forEach(o => totalMentions[o] = 0);
    const N_PERP = 3;
    const responses = await Promise.allSettled(AEO_QUESTIONS.slice(0,N_PERP).map(q =>
      axios.post('https://api.perplexity.ai/chat/completions',
        { model: 'sonar', max_tokens: 400, messages: [{ role:'user', content: q }] },
        { headers: { 'Authorization': `Bearer ${cfg.PERPLEXITY_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      )
    ));
    for (const r of responses) {
      if (r.status !== 'fulfilled') { cb(`  Perplexity question error: ${r.reason?.message}`, 'warn'); continue; }
      const text = r.value.data.choices[0].message.content;
      for (const org of orgs) {
        if (text.toLowerCase().includes(org.toLowerCase())) {
          totalMentions[org]++;
          if (!results[org].topResponse) results[org].topResponse = text.slice(0,200);
        }
      }
    }
    for (const org of orgs) {
      const score = Math.round(totalMentions[org] / N_PERP * 100);
      results[org].llmBreakdown['Perplexity'] = { mentions: totalMentions[org], score };
      cb(`  Perplexity — ${org}: ${totalMentions[org]}/${N_PERP} mentions`, totalMentions[org] > 0 ? 'ok' : 'warn');
    }
  }

  // Google Gemini — 3 questions in parallel
  if (cfg.GEMINI_KEY) {
    cb(`  Probing Google Gemini (gemini-1.5-flash) — 3 questions in parallel...`);
    let totalMentions = {}; orgs.forEach(o => totalMentions[o] = 0);
    const N_GEM = 3;
    const responses = await Promise.allSettled(AEO_QUESTIONS.slice(0,N_GEM).map(q =>
      axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.GEMINI_KEY}`,
        { contents: [{ parts: [{ text: q }] }], generationConfig: { maxOutputTokens: 400 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      )
    ));
    for (const r of responses) {
      if (r.status !== 'fulfilled') { cb(`  Gemini question error: ${r.reason?.message}`, 'warn'); continue; }
      const text = r.value.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      for (const org of orgs) {
        if (text.toLowerCase().includes(org.toLowerCase())) {
          totalMentions[org]++;
          if (!results[org].topResponse) results[org].topResponse = text.slice(0,200);
        }
      }
    }
    for (const org of orgs) {
      const score = Math.round(totalMentions[org] / N_GEM * 100);
      results[org].llmBreakdown['Gemini'] = { mentions: totalMentions[org], score };
      cb(`  Gemini — ${org}: ${totalMentions[org]}/${N_GEM} mentions`, totalMentions[org] > 0 ? 'ok' : 'warn');
    }
  }

  // Compute composite AEO score: average of all LLM scores
  for (const org of orgs) {
    const llmScores = Object.values(results[org].llmBreakdown).map(v => v.score);
    results[org].score = llmScores.length > 0 ? Math.round(llmScores.reduce((a,b)=>a+b,0) / llmScores.length) : 0;
    results[org].mentions = Object.values(results[org].llmBreakdown).reduce((a,b)=>a+b.mentions, 0);
  }

  return results; // { [org]: { score, mentions, llmBreakdown, topResponse } }
}

// ── Social Media: Twitter/X ────────────────────────────────────────────────
async function fetchTwitter(cfg, orgs, cb) {
  const results = {};
  for (const org of orgs) results[org] = { tweetCount: 0, topTweet: null, error: null };

  if (!cfg.TWITTER_KEY) return results;

  // Run all orgs in parallel — Promise.allSettled handles individual failures gracefully
  cb(`  Querying Twitter/X for ${orgs.length} orgs in parallel (rate-limited to 1 rps)...`);
  // Stagger requests by 1 second each to respect Twitter free-tier rate limit
  await Promise.allSettled(orgs.map((org, i) =>
    sleep(i * 1100).then(() =>
      axios.get('https://api.twitter.com/2/tweets/search/recent', {
        params: {
          query: `"${org}" air quality India -is:retweet lang:en`,
          max_results: 10,
          'tweet.fields': 'public_metrics,created_at',
        },
        headers: { 'Authorization': `Bearer ${cfg.TWITTER_KEY}` },
        timeout: 15000
      }).then(res => {
        const tweets = res.data.data || [];
        results[org].tweetCount = res.data.meta?.total_count || tweets.length;
        const best = tweets.sort((a,b) =>
          ((b.public_metrics?.like_count||0)+(b.public_metrics?.retweet_count||0)) -
          ((a.public_metrics?.like_count||0)+(a.public_metrics?.retweet_count||0))
        )[0];
        if (best) results[org].topTweet = {
          text: best.text?.slice(0,200)||'',
          likes: best.public_metrics?.like_count||0,
          retweets: best.public_metrics?.retweet_count||0,
          date: best.created_at?.slice(0,10)||''
        };
        cb(`  Twitter — ${org}: ${results[org].tweetCount} tweets`, results[org].tweetCount > 0 ? 'ok' : 'warn');
      }).catch(e => {
        results[org].error = e.response?.data?.detail || e.message;
        cb(`  Twitter error for ${org}: ${results[org].error}`, 'warn');
      })
    )
  ));
  return results;
}

// ── Social Media: YouTube ─────────────────────────────────────────────────
async function fetchYouTube(cfg, orgs, cb) {
  const results = {};
  for (const org of orgs) results[org] = { videoCount: 0, topVideo: null, error: null };

  // YouTube Data API v3 — uses API key if available; OAuth keys are available for future enhancements
  if (!cfg.YOUTUBE_KEY) return results;

  // Run all orgs in parallel — YouTube allows concurrent requests on the same key
  cb(`  Querying YouTube for ${orgs.length} orgs in parallel...`);
  await Promise.allSettled(orgs.map(org =>
    axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet', q: `${org} air quality India`,
        type: 'video', maxResults: 10, order: 'relevance',
        key: cfg.YOUTUBE_KEY, relevanceLanguage: 'en'
      },
      timeout: 15000
    }).then(res => {
      const items = res.data.items || [];
      results[org].videoCount = res.data.pageInfo?.totalResults || items.length;
      if (items[0]) results[org].topVideo = {
        title: items[0].snippet?.title?.slice(0,100)||'',
        channel: items[0].snippet?.channelTitle||'',
        date: (items[0].snippet?.publishedAt||'').slice(0,10),
        videoId: items[0].id?.videoId||'',
        url: `https://youtube.com/watch?v=${items[0].id?.videoId||''}`
      };
      cb(`  YouTube — ${org}: ${results[org].videoCount} videos`, results[org].videoCount > 0 ? 'ok' : 'warn');
    }).catch(e => {
      results[org].error = e.response?.data?.error?.message || e.message;
      cb(`  YouTube error for ${org}: ${results[org].error}`, 'warn');
    })
  ));
  return results;
}

// ── Core aggregation ───────────────────────────────────────────────────────
function aggregateOrg(artList, clsList, dateFrom) {
  const oc = {}; OUTLETS.forEach(o => oc[o]=0);
  artList.forEach(a => { const c=canonOutlet(a.source||''); if(c&&oc.hasOwnProperty(c))oc[c]++; });
  clsList.forEach(c => { const cn=canonOutlet(c.outlet||''); if(cn&&oc.hasOwnProperty(cn)&&oc[cn]===0)oc[cn]=1; });
  const so = Object.entries(oc).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const ac = 0;
  const dc = clsList.filter(c=>c.citation_quality==='Data Cited').length;
  const tc = {}; TOPICS.forEach(t=>tc[t]=0);
  clsList.forEach(c=>{
    const t=(c.aq_subtopic||'').trim();
    const match=TOPICS.find(tp=>
      tp.toLowerCase()===t.toLowerCase()||
      t.toLowerCase().includes(tp.toLowerCase().split(' ')[0].toLowerCase())
    );
    if(match) tc[match]++;
  });
  const wk={}; const st=new Date(dateFrom);
  for(let i=0;i<13;i++){const d=new Date(st);d.setDate(d.getDate()+i*7);wk[d.toISOString().slice(0,10)]=0;}
  const wkeys=Object.keys(wk);
  artList.forEach(a=>{
    const d=parseDateStr(a.date);
    if(d){const diff=Math.floor((d-st)/(7*86400000));if(diff>=0&&diff<13){wk[wkeys[diff]]++;return;}}
    wk[wkeys[0]]++;
  });
  const sov = Math.min(100, Math.round(artList.length*2.5));
  const authPct = clsList.length ? Math.round(ac/clsList.length*100) : 0;
  const dataPct = clsList.length ? Math.round(dc/clsList.length*100) : 0;
  return {
    total:artList.length, classified:clsList.length,
    authCount:ac, authPct, dataCount:dc, dataPct,
    outletCounts:oc, sortedOutlets:so,
    topOutlet:so[0]?.[0]||'N/A', topOutlets:so.slice(0,3).map(([o])=>o),
    topicCounts:tc, weeklyData:wk,
    authExamples:clsList.filter(c=>c.citation_quality==='Data Cited').slice(0,2),
    vagueExamples:clsList.filter(c=>c.citation_quality==='Named Mention').slice(0,2),
    classifications:clsList, sov, authPct, dataPct
  };
}

function computeScore(d, aeoScore, socialScore=0) {
  // socialScore is 0–10; multiply ×2 to keep max 20-pt contribution like before
  const tot = Math.round(d.sov*0.25 + d.dataPct*0.25 + aeoScore*0.30 + socialScore*2);
  return { ...d, aeo: aeoScore, social: socialScore, score: tot, grade: tot>=80?'A':tot>=65?'B':tot>=50?'C+':tot>=35?'D':'F' };
}

// ── Trend Detection ────────────────────────────────────────────────────────
async function detectTrend(cls, arts, orgs, claudeKey, cb) {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const topicCounts = {};
  const topicArticles = {};

  for (const org of orgs) {
    const artList = arts[org] || [];
    const clsList = cls[org] || [];
    clsList.forEach((item, idx) => {
      const art = artList[idx];
      const dateStr = art?.date || item.date || '';
      const d = parseDateStr(dateStr);
      if (d && d < cutoff) return;
      const topic = item.aq_subtopic || 'General AQ';
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      if (!topicArticles[topic]) topicArticles[topic] = [];
      topicArticles[topic].push({
        title: art?.title || '',
        snippet: art?.snippet || '',
        source: art?.source || item.outlet || ''
      });
    });
  }

  const sorted = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
  const [topTopic, topCount] = sorted[0] || ['', 0];

  if (topCount < 4) {
    cb(`[TREND] No spike detected. Skipping trend social fetch.`);
    return { detected: false };
  }

  const trendArts = (topicArticles[topTopic] || []).slice(0, 20);
  const articlesText = trendArts
    .map(a => `- "${a.title}" (${a.source}): ${a.snippet.slice(0, 100)}`)
    .join('\n');

  const prompt = `You are analysing a batch of air quality news articles that spiked in the last 48 hours.

Articles:
${articlesText}

Tracked organisations: ${orgs.join(', ')}

Return JSON only, no markdown, no explanation:
{
  "trend_topic": "<2-5 word label for what is trending>",
  "trend_summary": "<one sentence explaining why this is spiking now>",
  "orgs_mentioned": ["<org name>", ...],
  "orgs_implicated": ["<org name>", ...]
}

orgs_mentioned = orgs explicitly named in these articles.
orgs_implicated = orgs whose known research areas directly overlap with this trend topic, even if not named.
Only include org names from the tracked organisations list above.`;

  try {
    const raw = await callClaude(prompt, claudeKey, 800);
    const parsed = parseJ(raw);
    if (!parsed) {
      cb(`[TREND] Analysis returned no valid JSON. Skipping trend fetch.`, 'warn');
      return { detected: false };
    }
    const orgsMentioned  = (parsed.orgs_mentioned  || []).filter(o => orgs.includes(o));
    const orgsImplicated = (parsed.orgs_implicated || []).filter(o => orgs.includes(o));
    const orgsToFetch = [...new Set([...orgsMentioned, ...orgsImplicated])];
    const trendEvent = {
      detected: true,
      topic: parsed.trend_topic || topTopic,
      summary: parsed.trend_summary || '',
      triggeredAt: new Date().toISOString(),
      articleCount: topCount,
      orgsMentioned,
      orgsToFetch
    };
    cb(`[TREND] Spike detected: "${trendEvent.topic}" — ${topCount} articles in 48h. Orgs flagged: ${orgsToFetch.join(', ') || 'none'}`);
    return trendEvent;
  } catch (e) {
    cb(`[TREND] Claude analysis error: ${e.message}`, 'warn');
    return { detected: false };
  }
}

// PR wire sites and org's own domain — never count as third-party coverage
const PR_WIRE_DOMAINS = [
  'prnewswire.com','businesswire.com','globenewswire.com',
  'newswire.com','prlog.org','einpresswire.com','pib.gov.in','prwire.in',
  'prnewswire.co.in','accesswire.com'
];
const ORG_DOMAIN_HINTS = {
  'ceew': ['ceew.in'], 'cstep': ['cstep.in'], 'wri': ['wri.org'],
  'icct': ['theicct.org'], 'teri': ['teriin.org','teri.res.in'],
  'cse': ['cseindia.org'], 'care4air': ['care4air.org'],
  'iforest': ['indiaforrenewables.org']
};
function isThirdParty(url, orgName) {
  const u = (url||'').toLowerCase();
  if (PR_WIRE_DOMAINS.some(d => u.includes(d))) return false;
  const orgKey = orgName.toLowerCase().replace(/[^a-z]/g,'');
  for (const [key, domains] of Object.entries(ORG_DOMAIN_HINTS)) {
    if (orgKey.includes(key) && domains.some(d => u.includes(d))) return false;
  }
  const abbrev = orgKey.slice(0, Math.min(6, orgKey.length));
  if (abbrev.length >= 4) {
    try { if (new URL(url).hostname.includes(abbrev)) return false; } catch {}
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN PIPELINE EXPORT
// ══════════════════════════════════════════════════════════════════════════
async function run(cfg, cb) {
  // cfg: { ORGS[], DATE_FROM, DATE_TO, CLIENT_NAME, SERPER_KEY, CLAUDE_KEY, CLAUDE_MODEL,
  //         OPENAI_KEY?, PERPLEXITY_KEY?, GEMINI_KEY?, TWITTER_KEY?, YOUTUBE_KEY?, outDir }
  // cb(message, level) — streams log lines

  const { ORGS, DATE_FROM, DATE_TO, CLIENT_NAME } = cfg;

  const SCOPE_KEYWORDS = cfg.SCOPE_KEYWORDS?.length
    ? cfg.SCOPE_KEYWORDS
    : ['air quality','AQI','PM2.5','PM10','air pollution','clean air','smog',
       'Black Carbon','Ozone','Ammonia','Carbon Monoxide','Nitrogen Dioxide','Methane','NCAP','GRAP'];

  const inRange = dateStr => {
    const d=parseDateStr(dateStr); if(!d) return true;
    const f=new Date(DATE_FROM),t=new Date(DATE_TO); t.setDate(t.getDate()+1);
    return d>=f && d<=t;
  };

  cb(`\n=== Emerald AI · AQ Intelligence Report ===`, 'head');
  cb(`Orgs: ${ORGS.join(', ')} · ${DATE_FROM} to ${DATE_TO}`);

  // ── STEP 1: Fetch articles ─────────────────────────────────
  cb(`\nSTEP 1/6 — Fetching articles from Serper...`, 'head');
  const arts = {}; for(const o of ORGS) arts[o]=[];

  for(const org of ORGS){
    const seen=new Set(); let skipped=0;
    for(const kw of SCOPE_KEYWORDS.slice(0,8)){
      const q=`"${org}" ${kw} India`;
      cb(`  ${q}`);
      try{
        const results=await serperSearch(q, cfg.SERPER_KEY);
        let added=0;
        for(const r of results){
          const k=r.link||r.title;
          if(!seen.has(k)){
            seen.add(k);
            if(!inRange(r.date||'')){skipped++;continue;}
            if(isThirdParty(r.link||'', org)){
              arts[org].push({title:r.title||'',snippet:r.snippet||'',source:r.source||dom(r.link||''),url:r.link||'',date:r.date||''});
              added++;
            }
          }
        }
        cb(`  +${added} kept, ${skipped} outside date range`, 'ok');
      }catch(e){ cb(`  Serper error: ${e.message}`, 'warn'); }
      await sleep(300);
    }
    cb(`  ${org}: ${arts[org].length} articles`, 'ok');
  }


  // ── STEP 1b: Scrape article text ───────────────────────────
  cb(`\nSTEP 1b/6 — Scraping full article text...`, 'head');
  for(const org of ORGS){
    // Cap at 6 scrapes per org — at 13 orgs this is 78 total, keeping runtime reasonable
    const toEnrich=arts[org].slice(0,6);
    for(let i=0;i<toEnrich.length;i++){
      const a=toEnrich[i]; if(!a.url) continue;
      const txt=await serperScrape(a.url, cfg.SERPER_KEY);
      if(txt&&txt.length>300){
        a.fullText=txt;
        cb(`  [${org} ${i+1}/${toEnrich.length}] scraped ${txt.length} chars`, 'ok');
      } else {
        a.fullText=`TITLE: ${a.title}\nSNIPPET: ${a.snippet}\n[Full text unavailable. If ${org} is not explicitly cited with data, mark Secondary Mention.]`;
        cb(`  [${org} ${i+1}/${toEnrich.length}] snippet fallback`, 'warn');
      }
      await sleep(250);
    }
  }

  // ── STEP 2: Classify with Claude ──────────────────────────
  cb(`\nSTEP 2/6 — Classifying with Claude (batches of 8)...`, 'head');
  const cls={}; for(const o of ORGS) cls[o]=[];

  for(const org of ORGS){
    // Cap at 16 articles per org for classification — enough for signal at large org counts
    const al=arts[org].slice(0,16);
    const batches=[];
    for(let i=0;i<al.length;i+=8) batches.push(al.slice(i,i+8));

    for(let bi=0;bi<batches.length;bi++){
      const batch=batches[bi];

      // Separate articles: those with 0 mentions in scraped text are pre-classified;
      // only articles where the org actually appears go to Claude.
      const scrapeGap=[], needsClaude=[];
      batch.forEach((a,j)=>{
        const ft=a.fullText||a.snippet||'';
        const mc=countMentions(ft, org);
        if(mc===0) scrapeGap.push({j,a,mc});
        else        needsClaude.push({j,a,mc,ft});
      });

      // Pre-classify scrape-gap articles deterministically — Claude has nothing useful to see
      const preItems=scrapeGap.map(({j,a})=>({
        index:j, outlet:a.source||'', date:a.date||'',
        citation_quality:'Mention Not In Scraped Text',
        mention_count:0, aq_subtopic:'General AQ',
        evidence_quote:'org name not found in scraped text', confidence:'Low'
      }));

      if(needsClaude.length===0){
        cls[org]=cls[org].concat(preItems);
        cb(`  ${org} batch ${bi+1}/${batches.length} — ${scrapeGap.length} scrape-gap, skipped Claude`, 'warn');
        await sleep(100);
        continue;
      }

      // Build prompt using centered 700-char windows for articles that do have mentions
      const txt=needsClaude.map(({j,a,mc,ft})=>{
        const window=extractRelevantWindow(ft, org, 700);
        return `[${j}] SOURCE: ${a.source} | DATE: ${a.date} | ORG MENTIONS IN FULL SCRAPED TEXT: ${mc}\nTITLE: ${a.title}\nCONTENT: ${window}`;
      }).join('\n===\n');

      const prompt=`You are a media intelligence analyst classifying Indian news articles about air quality for the organisation "${org}".

For EACH numbered article, return one JSON object with:
- index: the article number shown in [brackets]
- citation_quality: "Data Cited" if a specific number, %, statistic, or named report FROM "${org}" appears in the CONTENT excerpt. "Named Mention" if org is named but no specific data cited. "Not Mentioned" if org does not appear in the excerpt. (Do NOT use "Mention Not In Scraped Text" — that is set before this step for articles not shown here.)
- mention_count: copy the ORG MENTIONS IN FULL SCRAPED TEXT number exactly as given — do not recount from the excerpt
- aq_subtopic: EXACTLY one of: NCAP, Policy, PM2.5 Exposure, Stubble Burning, Clean Air Finance, Vehicular Pollution, Health Impact, Industrial Pollution, Heat-AQI, Brick Kilns, Petrol Emissions, Diesel Emissions, Super Emitters, Thermal Power Plants, Household Pollution, Indoor Pollution, Biomass Air Pollution, Rice Residue Burning, Wheat Residue Burning, Road Dust, General AQ
- evidence_quote: exact phrase ≤12 words from content. "not mentioned" if absent.
- outlet: publication from SOURCE field
- date: date from DATE field
- confidence: "High" or "Low"

Note: CONTENT is a ~700-char window centered on the org's first mention in the scraped text — the org name should appear in it.

Return ONLY a JSON array. No preamble, no markdown.
[{"index":0,"outlet":"Times of India","date":"Mar 5, 2026","citation_quality":"Data Cited","mention_count":3,"aq_subtopic":"NCAP","evidence_quote":"CEEW found 23 of 131 cities met targets","confidence":"High"}]

ARTICLES:
${txt}`;

      cb(`  ${org} batch ${bi+1}/${batches.length}${scrapeGap.length>0?` (${scrapeGap.length} scrape-gap pre-classified)`:''}...`);
      try{
        const raw=await callClaude(prompt, cfg.CLAUDE_KEY, 2500);
        cb(`  preview: ${raw.slice(0,90).replace(/\n/g,' ')}`, 'warn');
        const parsed=parseJ(raw);
        if(parsed&&Array.isArray(parsed)&&parsed.length>0){
          // Merge Claude results with pre-classified, preserve original article order
          const all=[...preItems,...parsed].sort((a,b)=>(a.index||0)-(b.index||0));
          cls[org]=cls[org].concat(all);
          cb(`  +${all.length} classified (${parsed.length} Claude + ${preItems.length} scrape-gap)`, 'ok');
        } else {
          cb(`  parse failed: ${raw.slice(0,80)}`, 'err');
          if(preItems.length>0) cls[org]=cls[org].concat(preItems);
        }
      }catch(e){
        cb(`  Claude error: ${e.message}`, 'err');
        if(preItems.length>0) cls[org]=cls[org].concat(preItems);
      }
      await sleep(500);
    }
    cb(`  ${org} total classified: ${cls[org].length}`, cls[org].length>0?'ok':'err');
  }

  // ── STEP 2.5: Trend Detection ─────────────────────────────
  cb(`\nSTEP 2.5/6 — Trend Detection (48h spike analysis)...`, 'head');
  const trendEvent = await detectTrend(cls, arts, ORGS, cfg.CLAUDE_KEY, cb);
  let trendSocialData = null;
  if (trendEvent.detected) {
    cb(`[TREND] Fetching social data for: ${trendEvent.orgsToFetch.join(', ')}`);
    trendSocialData = await TS.fetchTrendSocial(trendEvent, cfg, cb);
  } else {
    cb('[TREND] No trend spike. Trend social fetch skipped.');
  }

  // ── STEP 3: AEO Visibility (via Social Intelligence module) ──
  cb(`\nSTEP 3/6 — AEO / LLM Visibility...`, 'head');
  let aeoResults = {};
  for (const org of ORGS) aeoResults[org] = { score:0, mentions:0, llmBreakdown:{}, topResponse:'', questionResults:{} };
  try {
    aeoResults = await SI.runAEO(cfg, ORGS, cb);
    delete aeoResults._queriesUsed; // remove metadata key — Object.values() calls later expect only org entries
    for (const org of ORGS) cb(`  ${org} AEO score: ${aeoResults[org].score}`, aeoResults[org].score>0?'ok':'warn');
  } catch(e) { cb(`  AEO error: ${e.message}`, 'err'); }

  // ── STEP 4: Social Media (X/Twitter · Instagram · LinkedIn via Serper) ──
  cb(`\nSTEP 4/6 — Social Media Intelligence...`, 'head');
  let siSocial = { youtube: null, twitter: null, instagram: null, linkedin: null };
  try {
    siSocial = await SI.runSocial(cfg, ORGS, cb);
  } catch(e) { cb(`  Social error: ${e.message}`, 'err'); }
  const socialScores = SI.computeSocialScore(siSocial, ORGS);
  for (const org of ORGS) {
    cb(`  Social score: ${org} = ${socialScores[org].total} pts (${socialScores[org].normalised}/10 normalised)`, 'ok');
  }

  // ── STEP 4b: Social ER (Apify — actual engagement rates) ──
  cb(`\nSTEP 4b/6 — Social Engagement Rate (Apify)...`, 'head');
  const SocialER = require('./social-er');
  let socialERResults = [];
  let socialERHtml = '';
  try {
    socialERResults = await SocialER.run(cfg, ORGS, cb);
    socialERHtml = SocialER.buildSocialERHtml(socialERResults);
    cb(`  Social ER complete: ${socialERResults.length} orgs scored`, socialERResults.length > 0 ? 'ok' : 'warn');
  } catch(e) { cb(`  Social ER error: ${e.message}`, 'err'); }

  // ── STEP 5: Aggregate + Score ─────────────────────────────
  cb(`\nSTEP 5/6 — Aggregating and scoring...`, 'head');
  const data={};
  for(const org of ORGS){
    const base = aggregateOrg(arts[org], cls[org], DATE_FROM);
    data[org] = computeScore(base, aeoResults[org].score, socialScores[org]?.normalised||0);
    cb(`  ${org}: ${data[org].total} arts | ${data[org].authPct}% auth | ${data[org].dataPct}% data | AEO ${data[org].aeo} | Social ${data[org].social} | score ${data[org].score} (${data[org].grade})`, 'ok');
  }

  // ── STEP 5a: General AQ landscape fetch (white-space gap analysis) ────────
  cb(`\nSTEP 5a/6 — Fetching general AQ landscape (white-space gaps)...`, 'head');
  let whiteSpaceArticles = [];
  try {
    const orgExclusions = ORGS.map(o => `-"${o}"`).join(' ');
    const generalQueries = [
      `air quality India ${orgExclusions}`,
      `air pollution India policy ${orgExclusions}`,
      `India AQI PM2.5 health ${orgExclusions}`
    ];
    const rawGeneral = [];
    for (const q of generalQueries) {
      try {
        const res = await serperSearch(q, cfg.SERPER_KEY);
        rawGeneral.push(...res);
        await sleep(200);
      } catch(e) { cb(`  general query error: ${e.message}`, 'warn'); }
    }
    const seen = new Set();
    const deduped = rawGeneral.filter(a => {
      const u = a.link||a.url||''; if (!u||seen.has(u)) return false; seen.add(u); return true;
    });
    const orgLower = ORGS.map(o => o.toLowerCase());
    whiteSpaceArticles = deduped.filter(a => {
      const text = ((a.title||'') + ' ' + (a.snippet||'')).toLowerCase();
      return !orgLower.some(o => text.includes(o));
    });
    cb(`  ${deduped.length} general AQ articles → ${whiteSpaceArticles.length} exclude tracked orgs`, whiteSpaceArticles.length>0?'ok':'warn');
  } catch(e) { cb(`  general AQ fetch error: ${e.message}`, 'warn'); }

  // ── STEP 5b: AI analysis ───────────────────────────────────
  cb(`\nSTEP 5b/6 — AI analysis (executive summary, gap narratives, actions)...`, 'head');
  const orgSummary = ORGS.map(o=>`${o}: ${data[o].total} arts, ${data[o].authPct}% auth, ${data[o].dataPct}% data-specific, AEO ${data[o].aeo}/100, Social ${data[o].social}/10 (YT=${siSocial.youtube?.orgMentions?.[o]?.total||0} TW=${siSocial.twitter?.orgMentions?.[o]?.total||0} IG=${siSocial.instagram?.orgMentions?.[o]?.total||0} LI=${siSocial.linkedin?.orgMentions?.[o]?.total||0}), top outlet: ${data[o].topOutlet}, topics 2+: ${Object.entries(data[o].topicCounts).filter(([,v])=>v>=2).map(([k])=>k).join(',')||'none'}`).join('\n');
  let emerging=[], execF=[], actions=[];

  try{
    cb('  Executive summary...');
    const r=await callClaude(
      `Write 3 comparative findings for a media intelligence report comparing these orgs on Indian air quality coverage ${DATE_FROM} to ${DATE_TO}.\nOrgs: ${ORGS.join(', ')}\n\nDATA (includes AEO/LLM visibility and social media):\n${orgSummary}\n\nRULES — follow strictly:\n- Cite ONLY directly observable counts and scores. NEVER use these phrases: "authoritative tone", "institutional credibility", "greater credibility", "more trustworthy".\n- When EITHER compared value is below 10, use raw counts (e.g. "4 vs 1 articles") not percentages. Use "Nx" ratios only when BOTH values are ≥5.\n- Each headline max 12 words. Each detail 2-3 sentences with specific numbers.\n- section_ref must be one of: "§03 Share of Voice", "§05 Topic Ownership", "§06 Narrative Position", "§07 Citation Quality", "§AEO LLM Visibility", "§Social Media".\nReturn ONLY JSON array of 3: [{"headline":"...","detail":"...","section_ref":"§03 Share of Voice"}]`,
      cfg.CLAUDE_KEY, 1200
    );
    execF=parseJ(r)||[];
    cb(`  ${execF.length} findings`, execF.length>0?'ok':'err');
  }catch(e){ cb(`  exec err: ${e.message}`, 'err'); }
  await sleep(300);

  try{
    cb('  White-space gap analysis...');
    if (whiteSpaceArticles.length < 3) {
      cb('  Not enough general AQ articles for gap analysis', 'warn');
      emerging = [];
    } else {
      const wsCombined = whiteSpaceArticles.slice(0, 30).map(a=>
        `${a.date||'unknown'}|${a.title||''}|${a.link||a.url||''}|${(a.snippet||'').slice(0,120)}`
      ).join('\n');
      const r = await callClaude(
        `You are analysing the broader Indian air quality media landscape from ${DATE_FROM} to ${DATE_TO}.\n\nThe tracked organisations are: ${ORGS.join(', ')}.\n\nThe articles below are from GENERAL Indian AQ news coverage — these articles do NOT mention any of the tracked organisations. They represent the AQ media landscape where the tracked orgs are ABSENT.\n\nIdentify 2–3 distinct topic clusters from these articles that the tracked organisations are NOT participating in. These are white-space opportunities — genuine gaps where the AQ media conversation is active but the tracked orgs have no presence.\n\nFor each gap topic:\n- "topic": short name (3–5 words)\n- "description": 1 sentence on what this topic covers and why it matters\n- "gap_signal": specific evidence from the articles (e.g. "6 articles on X, none mentioning ${ORGS.join('/')}") \n- "opportunity": 1 actionable sentence — what a tracked org could publish or say to enter this conversation\n- Only include supporting_articles that actually appear in the list below\n\nReturn ONLY JSON array: [{"topic":"...","description":"...","gap_signal":"...","opportunity":"...","supporting_articles":[{"title":"...","url":"...","date":"YYYY-MM-DD"}]}]\n\nARTICLES (date|title|url|snippet):\n${wsCombined}`,
        cfg.CLAUDE_KEY, 1600
      );
      emerging = parseJ(r)||[];
      cb(`  ${emerging.length} white-space gaps identified`, emerging.length>0?'ok':'warn');
    }
  }catch(e){ cb(`  gap analysis err: ${e.message}`, 'warn'); }
  await sleep(300);

  try{
    cb('  Action matrix...');
    const r=await Promise.race([
      callClaude(
        `Generate 4 actions for EACH of these orgs: ${ORGS.join(', ')} — based on Indian AQ media + AEO + social media intelligence.\n${orgSummary}\nWhite-space gap topics (AQ media conversations tracked orgs are absent from): ${emerging.map(e=>e.topic).join(',')||'none'}\nReturn ONLY JSON array of ${ORGS.length*4} objects: [{"org":"orgname","priority":"Fix Now|Leverage|Optimise|Invest","area":"Media|Topics|Narrative|AEO|Social","action":"...","rationale":"1-2 sentences with specific data"}]`,
        cfg.CLAUDE_KEY, Math.min(4000, 1000 + ORGS.length * 250)
      ),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('Action matrix timed out after 30s')),30000))
    ]);
    actions=parseJ(r)||[];
    cb(`  ${actions.length} actions`, actions.length>0?'ok':'err');
  }catch(e){ cb(`  actions err: ${e.message}`, 'err'); }

  // ── STEP 6: Build outputs ─────────────────────────────────
  cb(`\nSTEP 6/6 — Building report files...`, 'head');
  const stamp   = new Date().toISOString().slice(0,10);
  // Truncate filename for large org sets — max 3 names + count
  const orgLabel = ORGS.length <= 3
    ? ORGS.join('-vs-')
    : ORGS.slice(0,3).join('-vs-') + `-and-${ORGS.length-3}-more`;
  const base    = `aq-report-${orgLabel}-${stamp}`;
  const htmlFile= path.join(cfg.outDir, `${base}.html`);
  const pptxFile= path.join(cfg.outDir, `${base}.pptx`);
  const pptxName= `${base}.pptx`;

  await buildPPTX(data,{},emerging,execF,actions,arts,aeoResults,siSocial,socialScores,trendEvent,trendSocialData,pptxFile,cfg);
  cb(`  PPTX: ${pptxName}`, 'ok');

  const html=buildHTML(data,{},emerging,execF,actions,arts,aeoResults,siSocial,socialScores,trendEvent,trendSocialData,pptxName,cfg,socialERHtml);
  fs.writeFileSync(htmlFile, html, 'utf8');
  cb(`  HTML: ${base}.html (${Math.round(html.length/1024)}KB)`, 'ok');

  cb(`\n✓ Done — ${base}.html + ${pptxName}`, 'ok');
  return { htmlFile, pptxFile, htmlName: `${base}.html`, pptxName };
}

// ══════════════════════════════════════════════════════════════════════════
//  PPTX BUILDER
// ══════════════════════════════════════════════════════════════════════════
async function buildPPTX(data,comps,emerging,execF,actions,arts,aeoResults,siSocial,socialScores,trendEvent,trendSocialData,outFile,cfg) {
  const {ORGS,DATE_FROM,DATE_TO,CLIENT_NAME} = cfg;
  const pres=new PptxGen();
  pres.layout='LAYOUT_WIDE'; pres.author='Emerald AI';
  pres.title=`AQ Media Intelligence — ${ORGS.join(' vs ')}`;

  const BG='0a0e17',CARD='111520',CARD2='181e2e',BORD='252d40';
  const TXT='d8e4f0',MUTED='8fa3b8',AMBER='c9922a',GOOD='4caf74',WARN='d4a017';

  const darkBg  = sl => { sl.background={color:BG}; };
  const eyebrow = (sl,txt,y=0.25) => sl.addText(txt.toUpperCase(),{x:0.5,y,w:12.3,h:0.22,fontSize:9,bold:true,color:AMBER,charSpacing:3,fontFace:'Calibri'});
  const stitle  = (sl,txt,y=0.52) => sl.addText(txt,{x:0.5,y,w:12.3,h:0.55,fontSize:28,bold:true,color:TXT,fontFace:'Cambria'});
  const card    = (sl,x,y,w,h) => sl.addShape(pres.shapes.ROUNDED_RECTANGLE,{x,y,w,h,fill:{color:CARD},line:{color:BORD,width:0.5},rectRadius:0.08});
  const footer  = sl => sl.addText(`Emerald AI · AQ Intelligence · ${DATE_FROM} to ${DATE_TO} · CONFIDENTIAL`,{x:0.5,y:7.15,w:12.3,h:0.22,fontSize:8,color:MUTED,fontFace:'Calibri'});

  // Slide 1: Cover
  {
    const sl=pres.addSlide(); darkBg(sl);
    sl.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:13.3,h:2.4,fill:{color:'111520'},line:{color:'111520'}});
    sl.addText('AIR QUALITY MEDIA INTELLIGENCE',{x:0.6,y:0.48,w:12,h:0.38,fontSize:11,color:AMBER,charSpacing:4,bold:true,fontFace:'Calibri'});
    sl.addText('Air Quality\nTRIPLE Media Analytics',{x:0.6,y:0.92,w:10,h:1.3,fontSize:36,bold:true,color:TXT,fontFace:'Cambria'});
    // Org pills: 2 rows if >6 orgs, pill width adapts to count
    {
      const pillsPerRow = ORGS.length <= 6 ? ORGS.length : Math.ceil(ORGS.length / 2);
      const pillW = Math.min(2.3, (12.3 - 0.1 * (pillsPerRow - 1)) / pillsPerRow);
      ORGS.forEach((org,i)=>{
        const c=orgPptx(i);
        const col = i % pillsPerRow;
        const row = Math.floor(i / pillsPerRow);
        const px = 0.6 + col * (pillW + 0.1);
        const py = 2.55 + row * 0.55;
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE,{x:px,y:py,w:pillW,h:0.44,fill:{color:c,transparency:82},line:{color:c,width:1},rectRadius:0.05});
        sl.addText(org.length>12?org.slice(0,12)+'…':org,{x:px,y:py,w:pillW,h:0.44,fontSize:Math.max(9,13-Math.floor(ORGS.length/4)),bold:true,color:TXT,fontFace:'Calibri',align:'center',valign:'middle'});
      });
    }
    sl.addText(`Period: ${DATE_FROM}  →  ${DATE_TO}`,{x:0.6,y:3.2,w:6,h:0.28,fontSize:12,color:MUTED,fontFace:'Calibri'});
    // AEO indicator on cover
    const hasAEO = Object.values(aeoResults).some(v=>v.score>0);
    if(hasAEO) sl.addText('✓ LLM Visibility',{x:8,y:3.2,w:2.5,h:0.26,fontSize:10,color:GOOD,fontFace:'Calibri'});
    const hasTwSI  = (siSocial.twitter?.posts?.length||0) > 0;
    const hasYTSI  = (siSocial.youtube?.videos?.length||0) > 0;
    const hasIGSI  = (siSocial.instagram?.posts?.length||0) > 0;
    const hasLISI  = (siSocial.linkedin?.posts?.length||0) > 0;
    const socials = [hasTwSI&&'X/Twitter', hasYTSI&&'YouTube', hasIGSI&&'Instagram', hasLISI&&'LinkedIn'].filter(Boolean).join(' · ');
    if(socials) sl.addText(`✓ Social: ${socials}`,{x:8,y:3.52,w:5.3,h:0.26,fontSize:10,color:GOOD,fontFace:'Calibri'});
    sl.addText(`Prepared for ${CLIENT_NAME||'client'} · Generated ${new Date().toISOString().slice(0,10)} · CONFIDENTIAL`,{x:0.6,y:7.1,w:12,h:0.26,fontSize:9,color:MUTED,fontFace:'Calibri'});
  }

  // Slide 2: Executive Summary
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 01'); stitle(sl,'Executive Summary');
    const findings=execF.length>0?execF.slice(0,3):[
      {headline:`${ORGS[0]} leads AQ coverage`,detail:ORGS.map(o=>`${o}: ${data[o]?.total||0} articles`).join(', ')+'.',section_ref:'§03'},
      {headline:'Primary Source rates vary across orgs',detail:ORGS.map(o=>`${o}: ${data[o]?.authPct||0}% primary source`).join(', ')+'.',section_ref:'§06 Narrative Position'},
      {headline:'AEO/LLM visibility remains a shared gap',detail:ORGS.map(o=>`${o}: AEO ${data[o]?.aeo||0}/100`).join(', ')+'.',section_ref:'§AEO'}
    ];
    findings.forEach((f,i)=>{
      const y=1.28+i*1.58;
      card(sl,0.5,y,12.3,1.44);
      sl.addText(String(i+1),{x:0.65,y:y+0.1,w:0.5,h:0.9,fontSize:36,color:AMBER,fontFace:'Cambria',opacity:0.5});
      sl.addText(f.headline||'',{x:1.3,y:y+0.12,w:10.8,h:0.38,fontSize:14,bold:true,color:TXT,fontFace:'Calibri'});
      sl.addText(f.detail||'',{x:1.3,y:y+0.54,w:10.8,h:0.72,fontSize:11,color:MUTED,fontFace:'Calibri'});
    });
    footer(sl);
  }

  // Slide 3: Share of Voice
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 03'); stitle(sl,'Share of Voice');
    const tot=ORGS.reduce((s,o)=>s+(data[o]?.total||0),0);
    const chartData=[{name:'AQ Articles',labels:ORGS,values:ORGS.map(o=>data[o]?.total||0)}];
    sl.addChart(pres.charts.BAR,chartData,{
      x:0.5,y:1.22,w:7.8,h:4.6,barDir:'col',
      chartColors:ORGS.map((_,i)=>orgPptx(i)),
      chartArea:{fill:{color:CARD2}},catAxisLabelColor:MUTED,valAxisLabelColor:MUTED,
      valGridLine:{color:BORD,size:0.5},catGridLine:{style:'none'},
      showValue:true,dataLabelColor:TXT,dataLabelFontSize:11,
      showLegend:false,valAxisLineShow:false,catAxisLineShow:false,showTitle:false
    });
    // Stat cards: switch to a table for >4 orgs (cards overflow vertically)
    if (ORGS.length <= 4) {
      ORGS.forEach((org,i)=>{
        const d=data[org]; const y=1.22+i*1.42;
        card(sl,8.6,y,4.2,1.28);
        sl.addText(org,{x:8.78,y:y+0.1,w:3.8,h:0.28,fontSize:11,bold:true,color:orgPptx(i),fontFace:'Calibri',charSpacing:1});
        sl.addText(String(d?.total||0),{x:8.78,y:y+0.38,w:1.4,h:0.55,fontSize:34,bold:true,color:TXT,fontFace:'Calibri'});
        sl.addText('articles',{x:8.78,y:y+0.9,w:1.4,h:0.22,fontSize:10,color:MUTED,fontFace:'Calibri'});
        const pct=tot>0?Math.round((d?.total||0)/tot*100):0;
        sl.addText(`${pct}% share`,{x:10.3,y:y+0.38,w:2.3,h:0.28,fontSize:12,color:AMBER,fontFace:'Calibri',bold:true});
        sl.addText(`Top: ${d?.topOutlet||'N/A'}`,{x:10.3,y:y+0.7,w:2.3,h:0.22,fontSize:10,color:MUTED,fontFace:'Calibri'});
      });
    } else {
      // Summary table for 5+ orgs
      const trows = [
        [{text:'Org',options:{bold:true,color:MUTED,fontSize:9,fill:{color:CARD2}}},{text:'Articles',options:{bold:true,color:MUTED,fontSize:9,fill:{color:CARD2},align:'center'}},{text:'Share',options:{bold:true,color:AMBER,fontSize:9,fill:{color:CARD2},align:'center'}},{text:'Top Outlet',options:{bold:true,color:MUTED,fontSize:9,fill:{color:CARD2}}}],
        ...ORGS.map((org,i)=>{
          const d=data[org];
          const pct=tot>0?Math.round((d?.total||0)/tot*100):0;
          return [{text:org,options:{bold:true,color:orgPptx(i),fontSize:10,fill:{color:CARD}}},{text:String(d?.total||0),options:{color:TXT,fontSize:11,fill:{color:CARD},align:'center'}},{text:pct+'%',options:{color:AMBER,fontSize:11,fill:{color:CARD},align:'center'}},{text:d?.topOutlet||'N/A',options:{color:MUTED,fontSize:9,fill:{color:CARD}}}];
        })
      ];
      sl.addTable(trows,{x:8.5,y:1.22,w:4.3,colW:[1.4,0.85,0.7,1.35],rowH:0.32,border:{pt:0.5,color:BORD},fontFace:'Calibri'});
    }
    sl.addText(`Serper News API · ${new Date().toISOString().slice(0,10)} · AQ-scoped`,{x:0.5,y:6.98,w:8,h:0.24,fontSize:9,color:MUTED,fontFace:'Calibri'});
  }

  // Slide 4: Coverage Momentum
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 04'); stitle(sl,'Coverage Momentum');
    const weeks=Object.keys(data[ORGS[0]].weeklyData);
    const series=ORGS.map((org,i)=>({name:org,labels:weeks.map(w=>w.slice(5)),values:weeks.map(w=>data[org].weeklyData[w]||0)}));
    sl.addChart(pres.charts.LINE,series,{
      x:0.5,y:1.22,w:12.3,h:5.0,
      chartColors:ORGS.map((_,i)=>orgPptx(i)),
      chartArea:{fill:{color:CARD2}},catAxisLabelColor:MUTED,valAxisLabelColor:MUTED,
      valGridLine:{color:BORD,size:0.5},catGridLine:{style:'none'},
      lineSize:3,lineSmooth:false,
      showLegend:true,legendPos:'b',legendColor:TXT,legendFontSize:11,
      valAxisLineShow:false,catAxisLineShow:false,showTitle:false
    });
    footer(sl);
  }

  // Slide 5: Topic Ownership
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 05'); stitle(sl,'Topic Ownership Map');
    // For large org counts: split into groups of 5 — one table block per group
    const ORG_GROUPS = [];
    for (let gi=0; gi<ORGS.length; gi+=5) ORG_GROUPS.push(ORGS.slice(gi, gi+5));
    ORG_GROUPS.forEach((orgGroup, gIdx) => {
    const colW=[2.6,...orgGroup.map(()=>(12.3-2.6-0.1)/orgGroup.length)];
    const hdr=[
      {text:'AQ SUB-TOPIC',options:{bold:true,color:MUTED,fontSize:9,fill:{color:CARD2},align:'left'}},
      ...ORGS.map((org,i)=>({text:org,options:{bold:true,color:orgPptx(i),fontSize:10,fill:{color:CARD2},align:'center'}}))
    ];
    const rows=[hdr,...TOPICS.map(topic=>[
      {text:topic,options:{bold:true,color:TXT,fontSize:11,fill:{color:CARD}}},
      ...ORGS.map(org=>{
        const cnt=data[org].topicCounts[topic]||0;
        const label=cnt>=5?'Owns':cnt>=2?'Contests':'Absent';
        const fc=cnt>=5?GOOD:cnt>=2?'2d6ea8':BORD;
        return {text:`${label} · ${cnt}`,options:{color:cnt>=2?'0a0e17':MUTED,fontSize:10,fill:{color:fc,transparency:cnt>=2?55:92},align:'center'}};
      })
    ])];
    const tableY = gIdx === 0 ? 1.22 : 1.22;
    sl.addTable(rows,{x:0.5,y:tableY,w:12.3,colW,rowH:0.37,border:{pt:0.5,color:BORD},fontFace:'Calibri'});
    if (gIdx === ORG_GROUPS.length - 1)
      sl.addText('Owns = 5+ · Contests = 2–4 · Absent = 0–1 · Clustered by Claude Haiku',{x:0.5,y:6.98,w:12.3,h:0.24,fontSize:9,color:MUTED,fontFace:'Calibri'});
    }); // end ORG_GROUPS.forEach
  }

  // Slide 6: Narrative & Citation
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Sections 06 & 07'); stitle(sl,'Narrative Position & Citation Quality');
    // For large org counts: reduce card height and font sizes to fit
    const cw=Math.min(3.7,12.3/ORGS.length-0.2);
    const cardH = ORGS.length<=4 ? 2.68 : ORGS.length<=7 ? 2.0 : 1.6;
    const bigFontSz = ORGS.length<=4 ? 34 : ORGS.length<=7 ? 22 : 16;
    ORGS.forEach((org,i)=>{
      const d=data[org]; const x=0.5+i*(cw+0.25);
      card(sl,x,1.28,cw,cardH);
      sl.addText(org,{x:x+0.15,y:1.38,w:cw-0.3,h:0.28,fontSize:11,bold:true,color:orgPptx(i),fontFace:'Calibri',charSpacing:1});
      sl.addText(`${d.authPct}%`,{x:x+0.15,y:1.7,w:cw*0.48,h:0.68,fontSize:bigFontSz,bold:true,color:orgPptx(i),fontFace:'Calibri'});
      sl.addText('Primary Source',{x:x+0.15,y:2.36,w:cw*0.48,h:0.24,fontSize:10,color:MUTED,fontFace:'Calibri'});
      sl.addShape(pres.shapes.LINE,{x:x+cw*0.5+0.08,y:1.7,w:0,h:0.9,line:{color:BORD,width:0.5}});
      sl.addText(`${d.dataPct}%`,{x:x+cw*0.5+0.18,y:1.7,w:cw*0.48,h:0.68,fontSize:bigFontSz,bold:true,color:AMBER,fontFace:'Calibri'});
      sl.addText('Data Cited',{x:x+cw*0.5+0.18,y:2.36,w:cw*0.48,h:0.24,fontSize:10,color:MUTED,fontFace:'Calibri'});
      const ex=d.authExamples[0];
      if(ex?.evidence_quote){
        sl.addText(`"${ex.evidence_quote}"`,{x:x+0.15,y:2.72,w:cw-0.3,h:0.45,fontSize:9,color:MUTED,fontFace:'Calibri',italic:true});
        sl.addText(`${ex.outlet||''} · ${ex.date||''}`,{x:x+0.15,y:3.16,w:cw-0.3,h:0.2,fontSize:8,color:AMBER,fontFace:'Calibri'});
      }
    });
    sl.addChart(pres.charts.BAR,
      [{name:'Primary Source %',labels:ORGS,values:ORGS.map(o=>data[o].authPct||0)},{name:'Data Cited %',labels:ORGS,values:ORGS.map(o=>data[o].dataPct||0)}],
      {x:0.5,y:4.2,w:12.3,h:2.7,barDir:'col',barGrouping:'clustered',
        chartColors:[GOOD,AMBER],chartArea:{fill:{color:CARD2}},
        catAxisLabelColor:MUTED,valAxisLabelColor:MUTED,
        valGridLine:{color:BORD,size:0.5},catGridLine:{style:'none'},
        showValue:true,dataLabelColor:TXT,dataLabelFontSize:10,
        showLegend:true,legendPos:'t',legendColor:TXT,legendFontSize:10,
        valAxisLineShow:false,catAxisLineShow:false,showTitle:false});
    footer(sl);
  }

  // Slide 7: AEO / LLM Visibility
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'AEO — LLM VISIBILITY'); stitle(sl,'AI Engine Optimisation');
    sl.addText('How often is each organisation cited when AI models answer AQ questions? Based on 5 standard queries per LLM.',{x:0.5,y:1.12,w:12.3,h:0.32,fontSize:12,color:MUTED,fontFace:'Calibri'});

    const hasAEO = Object.values(aeoResults).some(v=>v.score>0);
    if(!hasAEO){
      card(sl,0.5,1.55,12.3,2.5);
      sl.addText('AEO data not collected this run.',{x:0.5,y:2.5,w:12.3,h:0.4,fontSize:16,color:MUTED,fontFace:'Calibri',align:'center'});
      sl.addText('Add OPENAI_KEY, PERPLEXITY_KEY, or GEMINI_KEY to enable LLM probing.',{x:0.5,y:3.0,w:12.3,h:0.4,fontSize:12,color:WARN,fontFace:'Calibri',align:'center'});
    } else {
      // Bar chart: AEO score per org
      sl.addChart(pres.charts.BAR,
        [{name:'AEO Score',labels:ORGS,values:ORGS.map(o=>aeoResults[o].score||0)}],
        {x:0.5,y:1.55,w:6,h:3.0,barDir:'col',
          chartColors:ORGS.map((_,i)=>orgPptx(i)),chartArea:{fill:{color:CARD2}},
          catAxisLabelColor:MUTED,valAxisLabelColor:MUTED,valGridLine:{color:BORD,size:0.5},catGridLine:{style:'none'},
          showValue:true,dataLabelColor:TXT,dataLabelFontSize:12,
          showLegend:false,valAxisLineShow:false,catAxisLineShow:false,showTitle:false,valAxisMaxVal:100});

      // LLM breakdown cards
      const llmNames = [...new Set(Object.values(aeoResults).flatMap(v=>Object.keys(v.llmBreakdown)))];
      ORGS.forEach((org,oi)=>{
        const ay=1.55+oi*1.6; if(ay>6.5) return;
        card(sl,6.8,ay,5.8,1.45);
        sl.addText(org,{x:6.95,y:ay+0.1,w:5.5,h:0.28,fontSize:11,bold:true,color:orgPptx(oi),fontFace:'Calibri'});
        sl.addText(`Overall AEO: ${aeoResults[org].score}/100 · ${aeoResults[org].mentions} total mentions`,{x:6.95,y:ay+0.42,w:5.5,h:0.24,fontSize:10,color:TXT,fontFace:'Calibri'});
        const bk = aeoResults[org].llmBreakdown;
        const bkStr = Object.entries(bk).map(([k,v])=>`${k}: ${v.mentions}/${AEO_QUESTIONS.length}`).join('  ·  ');
        sl.addText(bkStr||'No LLM data',{x:6.95,y:ay+0.7,w:5.5,h:0.24,fontSize:9,color:MUTED,fontFace:'Calibri'});
        if(aeoResults[org].topResponse){
          sl.addText(`"${aeoResults[org].topResponse.slice(0,120)}..."`,{x:6.95,y:ay+1.0,w:5.5,h:0.35,fontSize:8,color:MUTED,fontFace:'Calibri',italic:true});
        }
      });
    }
    sl.addText('AEO questions: "Which organisations are the most authoritative on Indian air quality?" and 4 similar. Score = (mentions/questions) × 100.',{x:0.5,y:6.98,w:12.3,h:0.24,fontSize:8,color:MUTED,fontFace:'Calibri',italic:true});
    footer(sl);
  }

  // Slide 8: Social Media (all 4 platforms from SI module)
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Social Media Intelligence'); stitle(sl,'Platform Presence Scorecard');
    sl.addText('Org mentions in top AQ content across YouTube · X/Twitter · Instagram · LinkedIn — Serper Search + YouTube Data API.',{x:0.5,y:1.12,w:12.3,h:0.32,fontSize:12,color:MUTED,fontFace:'Calibri'});

    const platforms4=[
      {label:'YouTube',key:'youtube',icon:'YT',col:'ff4444'},
      {label:'X/Twitter',key:'twitter',icon:'X',col:'e2e8f0'},
      {label:'Instagram',key:'instagram',icon:'IG',col:'e1306c'},
      {label:'LinkedIn',key:'linkedin',icon:'LI',col:'0a66c2'}
    ];
    const hasSocial = platforms4.some(p=>(siSocial[p.key]?.orgMentions && Object.values(siSocial[p.key]?.orgMentions||{}).some(v=>v.total>0)));

    if(!hasSocial){
      card(sl,0.5,1.55,12.3,2.0);
      sl.addText('Social media data not collected this run.',{x:0.5,y:2.3,w:12.3,h:0.4,fontSize:16,color:MUTED,fontFace:'Calibri',align:'center'});
      sl.addText('Add social media API keys and/or Serper key to enable.',{x:0.5,y:2.76,w:12.3,h:0.4,fontSize:12,color:WARN,fontFace:'Calibri',align:'center'});
    } else {
      // Platform × Org grid — 4 platform rows, Org columns
      const trows=[
        [{text:'Platform',options:{bold:true,color:MUTED,fontSize:9,fill:{color:'181e2e'}}},
         ...ORGS.map((o,i)=>({text:o,options:{bold:true,color:orgPptx(i),fontSize:10,fill:{color:'181e2e'},align:'center'}})),
         {text:'Platform Total',options:{bold:true,color:AMBER,fontSize:9,fill:{color:'181e2e'},align:'center'}}],
        ...platforms4.map(p=>{
          const orgCells=ORGS.map((org,i)=>{
            const pts=siSocial[p.key]?.orgMentions?.[org]?.total||0;
            return {text:String(pts),options:{color:pts>0?orgPptx(i):MUTED,fontSize:12,fill:{color:'111520'},align:'center',bold:pts>0}};
          });
          const platTotal=ORGS.reduce((s,o)=>s+(siSocial[p.key]?.orgMentions?.[o]?.total||0),0);
          return [{text:p.label,options:{bold:true,color:TXT,fontSize:11,fill:{color:'111520'}}},
            ...orgCells,
            {text:String(platTotal),options:{color:AMBER,fontSize:12,fill:{color:'111520'},align:'center',bold:true}}];
        }),
        [{text:'Social Score (0–10)',options:{bold:true,color:AMBER,fontSize:9,fill:{color:'181e2e'}}},
         ...ORGS.map((o,i)=>({text:String(socialScores[o]?.normalised||0),options:{bold:true,color:orgPptx(i),fontSize:12,fill:{color:'181e2e'},align:'center'}})),
         {text:'',options:{fill:{color:'181e2e'}}}]
      ];
      const colW=[2.2,...ORGS.map(()=>Math.min(2.0,(10.1-0.1*(ORGS.length-1))/ORGS.length)),1.5];
      sl.addTable(trows,{x:0.5,y:1.55,w:12.3,colW,rowH:0.44,border:{pt:0.5,color:BORD},fontFace:'Calibri'});

      // Trending topics boxes from YouTube and Twitter
      const ytTopics=(siSocial.youtube?.trendingTopics||[]).slice(0,5).join('  ·  ');
      const twTopics=(siSocial.twitter?.trendingTopics||[]).slice(0,5).join('  ·  ');
      if(ytTopics){sl.addText(`YT trending: ${ytTopics}`,{x:0.5,y:4.85,w:12.3,h:0.26,fontSize:10,color:MUTED,fontFace:'Calibri',italic:true});}
      if(twTopics){sl.addText(`X trending:  ${twTopics}`,{x:0.5,y:5.15,w:12.3,h:0.26,fontSize:10,color:MUTED,fontFace:'Calibri',italic:true});}
    }
    sl.addText('YouTube: Data API v3 broad AQ search · X/Twitter/Instagram/LinkedIn: Serper site: search · mention detection across title, description, comments',{x:0.5,y:6.98,w:12.3,h:0.24,fontSize:8,color:MUTED,fontFace:'Calibri',italic:true});
    footer(sl);
  }

  // Slide 8b: Trend Social Visibility (only when a spike was detected)
  if (trendEvent?.detected && trendSocialData?.length) {
    const sl=pres.addSlide(); darkBg(sl);
    eyebrow(sl,'Trend Social Intelligence');
    stitle(sl,'Trend Social Visibility');
    sl.addText(`Spike: "${trendEvent.topic}" · ${trendEvent.articleCount} articles · ${trendEvent.triggeredAt.slice(0,10)} · ${trendEvent.summary}`,
      {x:0.5,y:1.12,w:12.3,h:0.36,fontSize:10,color:MUTED,fontFace:'Calibri',italic:true});

    const trows=[
      [
        {text:'Org',              options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2}}},
        {text:'Relevance',        options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2},align:'center'}},
        {text:'X/Twitter',        options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2},align:'center'}},
        {text:'YouTube',          options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2},align:'center'}},
        {text:'Instagram',        options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2},align:'center'}},
        {text:'LinkedIn',         options:{bold:true,color:MUTED,  fontSize:9,fill:{color:CARD2},align:'center'}},
        {text:'Score',            options:{bold:true,color:AMBER,  fontSize:9,fill:{color:CARD2},align:'center'}}
      ],
      ...trendSocialData.map((entry,i)=>{
        const orgIdx=ORGS.indexOf(entry.org);
        const oc=orgPptx(orgIdx>=0?orgIdx:i);
        const relCol=entry.trendRelevance==='mentioned'?GOOD:WARN;
        return [
          {text:entry.org,                                           options:{bold:true,color:oc,    fontSize:10,fill:{color:CARD}}},
          {text:entry.trendRelevance==='mentioned'?'Mentioned':'Implicated', options:{color:relCol,fontSize:9,fill:{color:CARD},align:'center'}},
          {text:String(entry.platforms.x?.count||0),                options:{color:TXT,  fontSize:10,fill:{color:CARD},align:'center'}},
          {text:String(entry.platforms.youtube?.count||0),          options:{color:TXT,  fontSize:10,fill:{color:CARD},align:'center'}},
          {text:String(entry.platforms.instagram?.count||0),        options:{color:TXT,  fontSize:10,fill:{color:CARD},align:'center'}},
          {text:String(entry.platforms.linkedin?.count||0),         options:{color:TXT,  fontSize:10,fill:{color:CARD},align:'center'}},
          {text:String(entry.trendVisibilityScore),                 options:{bold:true,color:AMBER,fontSize:11,fill:{color:CARD},align:'center'}}
        ];
      })
    ];
    sl.addTable(trows,{x:0.5,y:1.55,w:12.3,colW:[2.5,1.5,1.5,2.0,1.5,1.5,1.8],rowH:0.42,border:{pt:0.5,color:BORD},fontFace:'Calibri'});
    sl.addText('Score: X/Twitter +25 · YouTube +25 · Instagram +15 · LinkedIn +15 · Mentioned in news +20 · Cap 100',
      {x:0.5,y:6.98,w:12.3,h:0.24,fontSize:8,color:MUTED,fontFace:'Calibri'});
    footer(sl);
  }

  // Slide 9: White-Space Gaps
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 08'); stitle(sl,'AQ Media White-Space Gaps');
    sl.addText('Topics the broader AQ media is covering that tracked orgs are absent from — narrative opportunities.',
      {x:0.5,y:1.12,w:12.3,h:0.32,fontSize:11,color:MUTED,fontFace:'Calibri',italic:true});
    const narrs=emerging.length>0?emerging.slice(0,2):[{topic:'Insufficient data',description:'Not enough general AQ articles fetched to identify gaps.',gap_signal:'',opportunity:''}];
    narrs.forEach((n,i)=>{
      const y=1.55+i*2.5; card(sl,0.5,y,12.3,2.32);
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE,{x:0.5,y,w:0.55,h:2.32,fill:{color:AMBER,transparency:78},line:{color:AMBER,width:0.5},rectRadius:0.04});
      sl.addText(n.topic||'',{x:1.18,y:y+0.1,w:11.1,h:0.38,fontSize:14,bold:true,color:TXT,fontFace:'Calibri'});
      sl.addText(n.description||'',{x:1.18,y:y+0.52,w:11.1,h:0.34,fontSize:11,color:MUTED,fontFace:'Calibri'});
      if(n.gap_signal) sl.addText(`Gap: ${n.gap_signal}`,{x:1.18,y:y+0.9,w:11.1,h:0.34,fontSize:10,color:WARN,fontFace:'Calibri'});
      if(n.opportunity) sl.addText(`Opportunity: ${n.opportunity}`,{x:1.18,y:y+1.3,w:11.1,h:0.7,fontSize:10,color:GOOD,fontFace:'Calibri'});
    });
    footer(sl);
  }

  // Slide 10: Scorecard — orgs ranked by score, paginate into groups of 5
  {
    const ordinalP=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
    const ranked=ORGS.map((org,idx)=>({org,idx,score:data[org].score})).sort((a,b)=>b.score-a.score);
    let _ls=null,_lr=0;
    ranked.forEach((o,idx)=>{ if(o.score===_ls){o.rank=_lr;} else {o.rank=idx+1;_lr=idx+1;_ls=o.score;} });
    const SCORE_GROUPS = [];
    for (let gi=0; gi<ranked.length; gi+=5) SCORE_GROUPS.push(ranked.slice(gi, gi+5));
    SCORE_GROUPS.forEach((orgGroup, gIdx) => {
    const sl=pres.addSlide(); darkBg(sl);
    eyebrow(sl, SCORE_GROUPS.length>1 ? `Section 09 — Part ${gIdx+1} of ${SCORE_GROUPS.length}` : 'Section 09');
    stitle(sl,'Competitive Scorecard');
    const cw=Math.min(3.7,12.3/orgGroup.length-0.15);
    orgGroup.forEach((entry,i)=>{
      const org=entry.org; const d=data[org]; const x=0.5+i*(cw+0.18);
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE,{x,y:1.28,w:cw,h:5.0,fill:{color:CARD},line:{color:orgPptx(entry.idx),width:1.5},rectRadius:0.1});
      sl.addText(org,{x,y:1.38,w:cw,h:0.28,fontSize:11,bold:true,color:orgPptx(entry.idx),fontFace:'Calibri',align:'center',charSpacing:1});
      const rc=entry.rank===1?GOOD:entry.rank<=3?WARN:MUTED;
      sl.addText(ordinalP(entry.rank),{x,y:1.68,w:cw,h:1.05,fontSize:48,bold:true,color:rc,fontFace:'Cambria',align:'center'});
      sl.addText(`${d.score} / 100`,{x,y:2.72,w:cw,h:0.3,fontSize:13,color:MUTED,fontFace:'Calibri',align:'center'});
      const bars=[{l:'Share of Voice',v:d.sov},{l:'Narrative',v:d.authPct},{l:'Citation',v:d.dataPct},{l:'AEO',v:d.aeo}];
      bars.forEach((b,bi)=>{
        const by=3.14+bi*0.62;
        sl.addText(b.l,{x:x+0.15,y:by,w:cw*0.52,h:0.22,fontSize:10,color:MUTED,fontFace:'Calibri'});
        sl.addShape(pres.shapes.RECTANGLE,{x:x+0.15,y:by+0.24,w:cw-0.3,h:0.1,fill:{color:CARD2},line:{color:BORD,width:0}});
        if(b.v>0) sl.addShape(pres.shapes.RECTANGLE,{x:x+0.15,y:by+0.24,w:(cw-0.3)*b.v/100,h:0.1,fill:{color:orgPptx(entry.idx)},line:{color:orgPptx(entry.idx),width:0}});
        sl.addText(b.v>0?String(b.v):(b.l==='AEO'?'N/A':String(b.v)),{x:x+cw-0.55,y:by,w:0.4,h:0.22,fontSize:10,bold:true,color:b.v>0?orgPptx(entry.idx):MUTED,fontFace:'Calibri',align:'right'});
      });
    });
    sl.addText('Score = (SoV×0.25) + (Narrative×0.25) + (Citation×0.20) + (AEO×0.30)',{x:0.5,y:6.98,w:12.3,h:0.24,fontSize:9,color:MUTED,fontFace:'Calibri'});
    }); // end SCORE_GROUPS
  }

  // Slide 11: Action Matrix
  {
    const sl=pres.addSlide(); darkBg(sl); eyebrow(sl,'Section 10'); stitle(sl,'Action Matrix');
    const priColors={'Fix Now':WARN,'Leverage':GOOD,'Optimise':'3d8ef0','Invest':'e05c5c'};
    const byOrg={}; ORGS.forEach(o=>byOrg[o]=(actions||[]).filter(a=>a.org===o));
    let y=1.28;
    for(const [oi,org] of ORGS.entries()){
      const orgActions=byOrg[org]||[]; if(!orgActions.length) continue;
      sl.addText(org,{x:0.5,y,w:12.3,h:0.28,fontSize:11,bold:true,color:orgPptx(oi),fontFace:'Calibri',charSpacing:1});
      y+=0.32;
      for(const a of orgActions.slice(0,4)){
        if(y>6.8) break;
        card(sl,0.5,y,12.3,0.72);
        const pc=priColors[a.priority]||AMBER;
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE,{x:0.5,y,w:1.1,h:0.72,fill:{color:pc,transparency:75},line:{color:pc,width:0.5},rectRadius:0.04});
        sl.addText(a.priority||'',{x:0.5,y:y+0.22,w:1.1,h:0.28,fontSize:9,bold:true,color:TXT,fontFace:'Calibri',align:'center'});
        sl.addText(a.action||'',{x:1.72,y:y+0.06,w:5.6,h:0.3,fontSize:11,bold:true,color:TXT,fontFace:'Calibri'});
        sl.addText(a.area||'',{x:1.72,y:y+0.38,w:1.2,h:0.22,fontSize:9,color:AMBER,fontFace:'Calibri'});
        sl.addText(a.rationale||'',{x:3.05,y:y+0.38,w:9.55,h:0.28,fontSize:9,color:MUTED,fontFace:'Calibri'});
        y+=0.82;
      }
      y+=0.1;
    }
    footer(sl);
  }

  await pres.writeFile({fileName:outFile});
}

// ══════════════════════════════════════════════════════════════════════════
//  HTML BUILDER  (adds AEO + Social sections)
// ══════════════════════════════════════════════════════════════════════════
function buildHTML(data,comps,emerging,execF,actions,arts,aeoResults,siSocial,socialScores,trendEvent,trendSocialData,pptxFilename,cfg,socialERHtml=''){
  const {ORGS,DATE_FROM,DATE_TO,CLIENT_NAME} = cfg;
  const now=new Date().toUTCString();
  const tot=ORGS.reduce((s,o)=>s+(data[o]?.total||0),0);

  function weekBars(){
    const wk=Object.keys(data[ORGS[0]].weeklyData);
    const mx=Math.max(...wk.map(w=>ORGS.reduce((s,o)=>s+(data[o]?.weeklyData[w]||0),0)),1);
    return wk.map(w=>{
      const bars=ORGS.map((org,i)=>{const c=data[org]?.weeklyData[w]||0;const h=Math.max(Math.round(c/mx*76),2);return `<div style="flex:1;border-radius:2px 2px 0 0;min-height:2px;background:${orgHex(i)};height:${h}px" title="${esc(org)}: ${c}"></div>`;}).join('');
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px"><div style="width:100%;display:flex;gap:2px;align-items:flex-end;height:76px">${bars}</div><div style="font-family:monospace;font-size:9px;color:#5e7494;text-align:center">${esc(w.slice(5))}</div></div>`;
    }).join('');
  }

  function sovBar(){
    const bars=ORGS.map((org,i)=>{const pct=tot>0?Math.round((data[org]?.total||0)/tot*100):0;return `<div style="background:${orgHex(i)};width:${pct}%;display:flex;align-items:center;padding-left:9px;font-family:monospace;font-size:11px;font-weight:500;color:#fff;min-width:0;overflow:hidden">${data[org]?.total||0}</div>`;}).join('');
    return `<div style="height:28px;background:#1e2638;border-radius:4px;overflow:hidden;display:flex;margin-bottom:12px">${bars}</div>`;
  }

  function outletRows(){
    return OUTLETS.map(outlet=>{
      if(!ORGS.some(o=>(data[o]?.outletCounts[outlet]||0)>0)) return '';
      const orgCnts=ORGS.map((o,i)=>({o,i,n:data[o]?.outletCounts[outlet]||0})).filter(x=>x.n>0).sort((a,b)=>b.n-a.n);
      if(!orgCnts.length) return '';
      const total=orgCnts.reduce((s,x)=>s+x.n,0);
      const top3=orgCnts.slice(0,3).map(x=>`<span style="display:inline-flex;align-items:center;gap:4px;font-family:monospace;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;background:${orgHex(x.i)}1a;color:${orgHex(x.i)};border:1px solid ${orgHex(x.i)}4d;white-space:nowrap">${esc(x.o)} (${x.n})</span>`).join(' ');
      const more=orgCnts.length>3?`<span style="font-family:monospace;font-size:10px;color:var(--muted)"> +${orgCnts.length-3} more</span>`:'';
      const eid='ot'+outlet.replace(/\W/g,'');
      let evItems='';
      orgCnts.slice(0,5).forEach(x=>{const a=arts[x.o].find(a=>canonOutlet(a.source||'')==outlet);if(a)evItems+=`<div class="ei"><div class="en" style="color:${orgHex(x.i)};font-weight:600">${esc(x.o)}</div><div class="eb"><div class="eq">${esc((a.snippet||a.title).slice(0,130))}</div><div class="es">${esc(outlet)} &middot; ${esc(a.date)}${a.url?`<br><a href="${esc(a.url)}" target="_blank">${esc(a.url.slice(0,65))}</a>`:''}</div></div></div>`;});
      return `<tr><td style="font-weight:600">${esc(outlet)}</td><td style="font-family:monospace;font-size:13px;font-weight:700;color:var(--muted2)">${total}</td><td style="line-height:2.2">${top3}${more}</td><td>${evItems?`<a class="ctag" onclick="td('${eid}')">&#8599; articles</a><div class="evd" id="${eid}">${evItems}</div>`:'<span class="lc">&#9888; no articles</span>'}</td></tr>`;
    }).join('');
  }

  function topicCards(){
    const topicSubtitles={
      'NCAP':'National Clean Air Programme — targets and compliance',
      'Policy':'Air quality regulations, standards, government actions',
      'PM2.5 Exposure':'City & ward-level exposure data, health burden',
      'Stubble Burning':'Parali, enforcement, seasonal contribution',
      'Clean Air Finance':'Funding flows, investment gaps, budgets',
      'Vehicular Pollution':'EV targets, transport emissions, FAME',
      'Health Impact':'Mortality, hospital admissions, DALY data',
      'Industrial Pollution':'Factory emissions, cement, steel plants',
      'Heat-AQI':'Summer heat compounding PM2.5 impacts',
      'Brick Kilns':'Brick kiln emissions, FCBTK, zig-zag technology',
      'Petrol Emissions':'Petrol vehicle tailpipe pollution',
      'Diesel Emissions':'Diesel generators, trucks, buses',
      'Super Emitters':'High-emission point sources, hotspots',
      'Thermal Power Plants':'Coal power plant emissions, FGD',
      'Household Pollution':'Cooking fuel, biomass, LPG substitution',
      'Indoor Pollution':'Indoor air quality, IAQ monitoring',
      'Biomass Air Pollution':'Wood, crop residue, biomass burning',
      'Rice Residue Burning':'Paddy straw burning, Punjab, Haryana',
      'Wheat Residue Burning':'Wheat stubble burning, post-harvest',
      'Road Dust':'Resuspended road dust, unpaved roads'
    };
    const tdefs=TOPICS.map(k=>({k,s:topicSubtitles[k]||k}));
    return tdefs.map(t=>{
      const orgData=ORGS.map((org,i)=>{
        const cv=data[org]?.topicCounts[t.k]||0;
        const ex=data[org]?.classifications.find(c=>c.aq_subtopic&&c.aq_subtopic.replace('-',' ').toLowerCase().includes(t.k.replace('-',' ').toLowerCase().split('/')[0]));
        return {org,i,cv,ex};
      }).sort((a,b)=>b.cv-a.cv);
      const maxCv=orgData[0]?.cv||1;
      const owning=orgData.filter(x=>x.cv>=5);
      const contesting=orgData.filter(x=>x.cv>=2&&x.cv<5);
      const absent=orgData.filter(x=>x.cv<2);
      const bars=[...owning,...contesting].map(x=>{
        const pct=Math.round(x.cv/maxCv*100);
        const badge=x.cv>=5?'badge-owns':'badge-con';
        const lbl=x.cv>=5?'Owns':'Contests';
        const link=x.ex?.url?`<a href="${esc(x.ex.url)}" target="_blank" style="color:var(--amber);font-family:monospace;font-size:10px;text-decoration:none;flex-shrink:0" title="${esc(x.ex.evidence_quote||'')}">&#8599;</a>`:
          (x.ex?.evidence_quote?`<span style="font-family:monospace;font-size:10px;color:var(--muted);flex-shrink:0;cursor:default" title="${esc(x.ex.evidence_quote||'')}">&#9432;</span>`:'');
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;font-weight:600;color:${orgHex(x.i)};width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.org)}</span><div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;background:${orgHex(x.i)};width:${pct}%;border-radius:4px"></div></div><span style="font-family:monospace;font-size:11px;font-weight:700;width:20px;text-align:right;color:${orgHex(x.i)};flex-shrink:0">${x.cv}</span><span class="ob ${badge}" style="flex-shrink:0">${lbl}</span>${link}</div>`;
      }).join('');
      const absentId='abs'+t.k.replace(/\W/g,'');
      const absentList=absent.map(x=>`<span style="font-family:monospace;font-size:10px;color:var(--muted)">${esc(x.org)} (${x.cv})</span>`).join('  ');
      const absentBlock=absent.length?`<div style="margin-top:8px"><a class="ctag" onclick="td('${absentId}')">${absent.length} absent (0–1 art${absent.length!==1?'s':''})</a><div class="evd" id="${absentId}" style="padding:10px 0;border:none"><div style="display:flex;flex-wrap:wrap;gap:8px">${absentList}</div></div></div>`:'';
      return `<div class="em-card" style="margin-bottom:14px;padding:16px 20px"><div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;gap:12px"><div><div style="font-size:15px;font-weight:600;color:var(--text)">${esc(t.k)}</div><div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(t.s)}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">${owning.length?`<span style="font-family:monospace;font-size:10px;background:rgba(76,175,116,.12);color:var(--good);border:1px solid rgba(76,175,116,.25);border-radius:3px;padding:2px 7px">${owning.length} owns</span>`:''}${contesting.length?`<span style="font-family:monospace;font-size:10px;background:rgba(61,142,240,.1);color:#3d8ef0;border:1px solid rgba(61,142,240,.25);border-radius:3px;padding:2px 7px">${contesting.length} contests</span>`:''}</div></div>${bars||`<div style="font-size:12px;color:var(--muted);padding:8px 0">No orgs with 2+ articles on this topic yet.</div>`}${absentBlock}</div>`;
    }).join('');
  }

  function narrTable(){
    const rows=ORGS.map((org,i)=>{
      const cls=data[org]?.classifications||[];
      const primary=cls.filter(c=>c.narrative_position==='Primary Source').length;
      const secondary=cls.filter(c=>c.narrative_position==='Secondary Mention').length;
      const notM=cls.filter(c=>c.narrative_position==='Not Mentioned').length;
      const total=cls.length;
      const pct=total>0?Math.round(primary/total*100):0;
      const exs=cls.filter(c=>c.narrative_position==='Primary Source').slice(0,2);
      const eid='nex'+org.replace(/\W/g,'');
      const exHtml=exs.length?`<a class="ctag" onclick="td('${eid}')">examples</a><div class="evd" id="${eid}">${exs.map(c=>`<div class="ei"><div class="eb"><div class="eq">${esc(c.evidence_quote||'')}</div><div class="es">${esc(c.outlet||'')} &middot; ${esc(c.date||'')}</div></div></div>`).join('')}</div>`:'—';
      return {org,i,primary,secondary,notM,total,pct,exHtml};
    }).sort((a,b)=>b.pct-a.pct);
    return `<table class="nt"><thead><tr><th>Org</th><th>Primary Source</th><th>Secondary Mention</th><th>Not Mentioned</th><th>Primary Source %</th><th>Examples</th></tr></thead><tbody>${
      rows.map(r=>`<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(r.i)}">${esc(r.org)}</span></td><td style="font-family:monospace;font-weight:700;color:var(--good)">${r.primary}</td><td style="font-family:monospace;color:var(--muted2)">${r.secondary}</td><td style="font-family:monospace;color:var(--muted)">${r.notM}</td><td><span style="font-family:monospace;font-weight:700;color:${orgHex(r.i)}">${r.pct}%</span></td><td>${r.exHtml}</td></tr>`).join('')
    }</tbody></table>`;
  }

  function donut(pct,color){const da=(pct/100*163.4).toFixed(1),db=(163.4-da).toFixed(1);return `<svg width="64" height="64" viewBox="0 0 64 64" style="flex-shrink:0"><circle cx="32" cy="32" r="26" fill="none" stroke="#1e2638" stroke-width="10"/><circle cx="32" cy="32" r="26" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${da} ${db}" stroke-dashoffset="41" stroke-linecap="round"/><text x="32" y="37" text-anchor="middle" fill="${color}" font-size="13" font-family="Inter" font-weight="700">${pct}%</text></svg>`;}

  // AEO Section HTML
  function aeoSection(){
    function aeoGrade(score){
      if(score>=65)return{g:'S',label:'Sector Leader'};
      if(score>=45)return{g:'A',label:'Strong Visibility'};
      if(score>=28)return{g:'B',label:'Good Visibility'};
      if(score>=12)return{g:'C',label:'Developing'};
      if(score>=3) return{g:'D',label:'Limited'};
      return           {g:'E',label:'Not yet visible'};
    }
    function donutGrade(score,color){
      const {g}=aeoGrade(score);
      const da=(score/100*163.4).toFixed(1),db=(163.4-da).toFixed(1);
      return `<svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="#1e2638" stroke-width="10"/><circle cx="32" cy="32" r="26" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${da} ${db}" stroke-dashoffset="41" stroke-linecap="round"/><text x="32" y="38" text-anchor="middle" fill="${color}" font-size="18" font-family="Inter" font-weight="700">${g}</text></svg>`;
    }
    const hasAEO = Object.values(aeoResults).some(v=>v.score>0);
    const llmNames = [...new Set(Object.values(aeoResults).flatMap(v=>Object.keys(v.llmBreakdown)))];
    const aeoQs = AEO_QUESTIONS.map((q,i)=>`<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px"><div style="font-family:monospace;font-size:10px;color:var(--amber);flex-shrink:0;padding-top:2px">${i+1}</div><div style="color:var(--muted2)">${esc(q)}</div></div>`).join('');
    const cards = ORGS.map((org,i)=>{
      const a=aeoResults[org];
      const col=orgHex(i);
      const bk=Object.entries(a.llmBreakdown||{}).map(([llm,v])=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted2)">${esc(llm)}</span><span style="font-family:monospace;font-weight:600;color:${col}">${v.mentions}/${v.total||'?'} mentions</span></div>`).join('');
      return `<div class="cqp" style="border-top:2px solid ${col}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:12px">${esc(org)}</div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          ${donutGrade(a.score,col)}
          <div><div style="font-size:12px;color:var(--muted2);margin-bottom:4px">AEO Score</div><div style="font-family:monospace;font-size:18px;font-weight:700;color:${col}">${aeoGrade(a.score).g} <span style="font-size:12px;color:var(--muted)">(${a.score}/100)</span></div><div style="font-size:11px;color:var(--muted);margin-top:2px">${a.mentions} total LLM mentions</div></div>
        </div>
        ${bk||'<div style="font-size:11px;color:var(--muted)">No LLM data collected</div>'}
        ${a.topResponse?`<div class="cqe cqd" style="margin-top:10px"><div class="cqet">Example LLM response</div><div style="color:var(--text);font-family:monospace;font-size:11px;line-height:1.5">&ldquo;${esc(a.topResponse)}&rdquo;</div></div>`:''}
      </div>`;
    }).join('');
    const grid = ORGS.length<=2 ? `display:grid;grid-template-columns:repeat(${ORGS.length},1fr);gap:16px;margin-bottom:20px` : `display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px`;
    return `
<section class="sec" id="aeo"><div class="sh"><div class="se">AEO — LLM Visibility</div><h2 class="st">AI Engine Optimisation</h2>
<div class="sd">How often is each organisation cited when AI models (GPT-4o, Perplexity, Gemini) are asked about Indian air quality? ${hasAEO?'Probed with '+AEO_QUESTIONS.length+' standard questions per LLM.':'No LLM API keys provided — add keys to enable.'}</div><div class="sdiv"></div></div>
${!hasAEO?`<div style="background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.3);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted2)"><strong style="color:var(--warn)">⚠ AEO data not available</strong> — Add OpenAI, Perplexity, or Gemini API keys and re-run to populate this section. AEO contributes 30% of the scorecard.</div>`:''}
<div style="${grid}">${cards}</div>
<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
  <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px">Standard AEO questions (${AEO_QUESTIONS.length} per LLM)</div>
  ${aeoQs}
</div></section>`;
  }

  // Social Media Section HTML
  function socialSection(){
    const hasTw = Object.values(twitterData).some(v=>v.tweetCount>0);
    const hasYT = Object.values(youtubeData).some(v=>v.videoCount>0);
    const twitterCards = hasTw ? ORGS.map((org,i)=>{
      const tw=twitterData[org]; const col=orgHex(i);
      return `<div class="cqp" style="border-top:2px solid ${col}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:10px">${esc(org)}</div>
        <div style="font-family:monospace;font-size:26px;font-weight:700;color:${col};margin-bottom:4px">${tw.tweetCount||0}</div>
        <div style="font-size:12px;color:var(--muted2);margin-bottom:10px">tweets (last 7 days)</div>
        ${tw.topTweet?`<div class="cqe cqd"><div class="cqet">Top tweet by engagement</div><div style="color:var(--text);font-family:monospace;font-size:11px;line-height:1.5">&ldquo;${esc(tw.topTweet.text)}&rdquo;</div><div style="color:var(--muted);font-family:monospace;font-size:10px;margin-top:4px">♥ ${tw.topTweet.likes} · ↺ ${tw.topTweet.retweets} · ${esc(tw.topTweet.date)}</div></div>`:'<div style="font-size:11px;color:var(--muted)">No tweets found in last 7 days</div>'}
        ${tw.error?`<div style="font-size:10px;color:var(--warn);margin-top:6px;font-family:monospace">Error: ${esc(tw.error)}</div>`:''}
      </div>`;
    }).join('') : '';

    const youtubeCards = hasYT ? ORGS.map((org,i)=>{
      const yt=youtubeData[org]; const col=orgHex(i);
      return `<div class="cqp" style="border-top:2px solid ${col}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:10px">${esc(org)}</div>
        <div style="font-family:monospace;font-size:26px;font-weight:700;color:${col};margin-bottom:4px">${yt.videoCount||0}</div>
        <div style="font-size:12px;color:var(--muted2);margin-bottom:10px">videos found</div>
        ${yt.topVideo?`<div class="cqe cqd"><div class="cqet">Top video by relevance</div><div style="color:var(--text);font-family:monospace;font-size:11px;line-height:1.5">&ldquo;${esc(yt.topVideo.title)}&rdquo;</div><div style="color:var(--muted);font-family:monospace;font-size:10px;margin-top:4px">${esc(yt.topVideo.channel)} · ${esc(yt.topVideo.date)}</div><a href="${esc(yt.topVideo.url)}" target="_blank" style="font-family:monospace;font-size:10px;color:var(--amber);text-decoration:none">${esc(yt.topVideo.url)}</a></div>`:'<div style="font-size:11px;color:var(--muted)">No videos found</div>'}
        ${yt.error?`<div style="font-size:10px;color:var(--warn);margin-top:6px;font-family:monospace">Error: ${esc(yt.error)}</div>`:''}
      </div>`;
    }).join('') : '';

    const noData = !hasTw && !hasYT;
    const grid = `display:grid;grid-template-columns:repeat(${Math.min(ORGS.length,3)},1fr);gap:16px;margin-bottom:20px`;

    return `
<section class="sec" id="social"><div class="sh"><div class="se">Social Media Intelligence</div><h2 class="st">Twitter/X &amp; YouTube</h2>
<div class="sd">Social media presence and engagement around each organisation&rsquo;s AQ coverage. ${noData?'No social media API keys provided.':'Twitter search is limited to the last 7 days (free tier). Instagram and LinkedIn are not available via public API.'}</div><div class="sdiv"></div></div>
${noData?`<div style="background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.3);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted2)"><strong style="color:var(--warn)">⚠ Social media data not available</strong> — Add SERPER_KEY and re-run to enable X, Instagram, and LinkedIn intelligence.</div>`:''}
${hasTw?`<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px">🐦 Twitter / X <span style="font-size:11px;font-weight:400;color:var(--muted);font-family:monospace">(7-day window, free tier)</span></div><div style="${grid}">${twitterCards}</div>`:''}
${hasYT?`<div style="font-size:13px;font-weight:600;color:var(--text);margin:20px 0 12px">▶ YouTube <span style="font-size:11px;font-weight:400;color:var(--muted);font-family:monospace">(relevance search)</span></div><div style="${grid}">${youtubeCards}</div>`:''}
</section>`;
  }

  const clsNotice=ORGS.every(o=>(data[o]?.classified||0)===0)
    ?`<div style="background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.3);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted2)"><strong style="color:var(--warn)">&#9888; Classification unavailable</strong> &mdash; Claude API calls failed. Check CLAUDE_KEY and re-run.</div>`:'';

  function scRow(label,val,color,barPct){return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px"><span style="color:var(--muted2)">${label}</span><div style="flex:1;margin:0 9px;height:4px;background:#1e2638;border-radius:2px;overflow:hidden"><div style="height:100%;border-radius:2px;background:${color};width:${barPct!==undefined?Math.min(barPct,100):val}%"></div></div><span style="font-family:monospace;font-size:11px;font-weight:600;width:30px;text-align:right;color:${color}">${val}</span></div>`;}

  const topicCols=`175px ${ORGS.map(()=>'1fr').join(' ')}`;
  const orgChips=ORGS.map((o,i)=>`<span class="chip" style="background:${orgHex(i)}1a;color:${orgHex(i)};border:1px solid ${orgHex(i)}4d"><span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${orgHex(i)}"></span>${esc(o)}</span>`).join('');
  const navOrgs=ORGS.map(o=>`<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted2);padding:3px 20px"><div style="width:8px;height:8px;border-radius:2px;background:${orgHex(ORGS.indexOf(o))}"></div>${esc(o)}: ${data[o].total} arts</div>`).join('');

  function citTable(){
    const rows=ORGS.map((org,i)=>{
      const cls=data[org]?.classifications||[];
      const total=cls.length;
      const cited=cls.filter(c=>c.citation_quality==='Data Cited').length;
      const named=cls.filter(c=>c.citation_quality==='Named Mention').length;
      const notInScrape=cls.filter(c=>c.citation_quality==='Mention Not In Scraped Text').length;
      const pct=total>0?Math.round(cited/total*100):0;
      // Match cited articles with their URLs via index alignment
      const evidenceItems = cls.reduce((acc,c,ci)=>{
        if(c.citation_quality==='Data Cited' && acc.length<3){
          const art=arts[org]?.[ci];
          acc.push({quote:c.evidence_quote||'',outlet:c.outlet||'',date:c.date||'',url:art?.url||''});
        }
        return acc;
      },[]);
      const evCell = evidenceItems.length
        ? evidenceItems.map(e=>`<div style="margin-bottom:5px"><div style="font-family:monospace;font-size:10px;color:var(--amber);line-height:1.5">&ldquo;${esc(e.quote)}&rdquo;</div><div style="font-family:monospace;font-size:10px;color:var(--muted)">${esc(e.outlet)} &middot; ${esc(e.date)}</div>${e.url?`<a href="${esc(e.url)}" target="_blank" style="font-family:monospace;font-size:10px;color:var(--amber);text-decoration:none">&#8599; article</a>`:''}</div>`).join('')
        : `<span style="color:var(--muted);font-family:monospace;font-size:11px">—</span>`;
      return {org,i,total,cited,named,notInScrape,pct,evCell};
    }).sort((a,b)=>b.pct-a.pct);
    return `<table class="nt"><thead><tr><th>Org</th><th>Total</th><th>Data Cited</th><th>Named Mention</th><th title="Org confirmed on page by Google but not found in 2000-char scraped text">Not In Scrape</th><th>Evidence (Data Cited articles)</th></tr></thead><tbody>${
      rows.map(r=>`<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(r.i)}">${esc(r.org)}</span></td><td style="font-family:monospace">${r.total}</td><td><span style="font-family:monospace;font-weight:700;color:var(--good)">${r.cited}</span> <span style="font-family:monospace;font-size:10px;color:var(--muted)">(${r.pct}%)</span></td><td style="font-family:monospace;color:var(--muted2)">${r.named}</td><td style="font-family:monospace;color:#8b7cf8">${r.notInScrape||'—'}</td><td>${r.evCell}</td></tr>`).join('')
    }</tbody></table>`;
  }


  const ordinal=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
  const rankCol=r=>r===1?'var(--good)':r<=3?'var(--amber)':'var(--muted2)';
  const rankedOrgs=ORGS.map((org,i)=>({org,i,score:data[org].score})).sort((a,b)=>b.score-a.score);
  let _lastScore=null,_lastRank=0;
  rankedOrgs.forEach((o,idx)=>{ if(o.score===_lastScore){o.rank=_lastRank;} else {o.rank=idx+1;_lastRank=idx+1;_lastScore=o.score;} });
  const scorecards=rankedOrgs.map(({org,i,rank})=>{
    const d=data[org];
    return `<div class="sca" style="border-top:3px solid ${orgHex(i)}"><div class="scn" style="color:${orgHex(i)}">${esc(org)}</div><div class="scg" style="color:${rankCol(rank)}">${ordinal(rank)}</div><div class="scs">${d.score} / 100</div>
<div style="display:flex;flex-direction:column;gap:8px;text-align:left">
${scRow('Share of Voice',d.sov,orgHex(i))}${scRow('Citation',d.dataPct,orgHex(i))}${scRow('AEO',d.aeo,d.aeo>0?orgHex(i):'#5e7494')}${scRow('Social',d.social||0,d.social>0?orgHex(i):'#5e7494',(d.social||0)*10)}
</div></div>`;
  }).join('');

  const appendixSections=ORGS.map(org=>{
    const d=data[org];
    const cqColor=q=>q==='Data Cited'?'var(--good)':q==='Named Mention'?'var(--muted2)':q==='Mention Not In Scraped Text'?'#8b7cf8':'var(--muted)';
    const rows=arts[org].slice(0,15).map((a,i)=>{const c=d.classifications[i]||{};const cq=c.citation_quality||'—';return `<tr><td>${i+1}</td><td>${esc(a.source||'')}</td><td style="font-size:10px">${esc(a.date||'')}</td><td style="max-width:260px">${esc(a.title||'')}</td><td style="font-size:10px;font-family:monospace;color:${cqColor(cq)}">${esc(cq)}</td><td>${a.url?`<a href="${esc(a.url)}" target="_blank">link</a>`:'—'}</td></tr>`;}).join('');
    return `<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:9px">${esc(org)} &mdash; ${d.total} articles</div>
<table class="apt"><thead><tr><th>#</th><th>Outlet</th><th>Date</th><th>Headline</th><th>Classification</th><th>URL</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-bottom:24px"></div>`;
  }).join('');

  const execCards=(execF.length>0?execF:[{headline:`${ORGS[0]} leads AQ coverage`,detail:ORGS.map(o=>`${o}: ${data[o]?.total||0} articles`).join(', ')+'.',section_ref:'§03'}]).slice(0,3).map((f,i)=>
    `<div class="fc"><div class="fn">${i+1}</div><div class="fb"><div class="fh">${esc(f.headline)}</div><div class="fd">${esc(f.detail)}${f.section_ref?` <span style="font-family:monospace;font-size:10px;color:var(--muted)">&rarr; ${esc(f.section_ref)}</span>`:''}</div></div></div>`
  ).join('');

  const emergingCards=(!emerging||!emerging.length)
    ?`<div class="em-card"><div class="em-topic">Insufficient data</div><div class="em-body">Not enough general AQ articles were fetched to identify white-space gaps. Check the Serper key or broaden the date range.</div></div>`
    :emerging.map(n=>{
      const articleLinks=(n.supporting_articles||[]).map(a=>
        a.url
          ?`<div class="em-src"><a href="${esc(a.url)}" target="_blank" style="color:var(--amber);text-decoration:none">${esc(a.title)}</a></div>`
          :`<div class="em-src">${esc(a.title||a)}</div>`
      ).join('');
      return `<div class="em-card">
<div class="em-hdr"><div class="em-topic">${esc(n.topic)}</div></div>
<div class="em-body">${esc(n.description||'')}</div>
${n.gap_signal?`<div class="em-inf" style="color:var(--warn)">&#9888; Gap signal: ${esc(n.gap_signal)}</div>`:''}
${n.opportunity?`<div class="em-inf" style="color:var(--good);margin-top:6px">&#8594; Opportunity: ${esc(n.opportunity)}</div>`:''}
${articleLinks?`<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">${articleLinks}</div>`:''}
</div>`;
    }).join('');

  const pmap={'Fix Now':'pri-fix','Leverage':'pri-lev','Optimise':'pri-opt','Invest':'pri-inv'};
  const actionRows=(!actions||!actions.length)
    ?`<tr><td colspan="5" style="color:var(--muted)">Action matrix generation failed</td></tr>`
    :actions.map(a=>{const oi=ORGS.indexOf(a.org);const oc=oi>=0?orgHex(oi):'#c9922a';return `<tr><td style="font-weight:600;color:${oc}">${esc(a.org)}</td><td><span class="${pmap[a.priority]||'pri-opt'}">${esc(a.priority)}</span></td><td style="font-family:monospace;font-size:11px;color:var(--muted2)">${esc(a.area)}</td><td>${esc(a.action)}</td><td class="rat">${esc(a.rationale)}</td></tr>`;}).join('');

  const CSS=`:root{--ink:#0a0e17;--surface:#111520;--surface2:#181e2e;--surface3:#1e2638;--border:#252d40;--border2:#2e3a52;--text:#d8e4f0;--muted:#5e7494;--muted2:#8fa3b8;--amber:#c9922a;--amber-dim:rgba(201,146,42,.12);--amber-glow:rgba(201,146,42,.06);--good:#4caf74;--warn:#d4a017;--bad:#e05c5c}
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
.main{flex:1;min-width:0;padding:0 48px 80px;max-width:960px}
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
.cp{display:grid;grid-template-columns:${ORGS.map(()=>'1fr').join(' ')};gap:16px;margin-bottom:16px}
.op{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:20px}
.opn{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px}
.mch{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px}
.ch-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
.wbars{display:flex;gap:5px;align-items:flex-end;height:96px;margin-bottom:8px}
.tg{display:grid;grid-template-columns:${topicCols};border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px;font-size:12px}
.tgh{background:var(--surface3);padding:10px 14px;font-family:monospace;font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.tc{padding:12px 14px;border-bottom:1px solid var(--border);border-right:1px solid var(--border)}
.tc:nth-child(${ORGS.length+1}n){border-right:none}
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
@media(max-width:900px){.sidenav{display:none}.main{padding:24px 20px 60px}.cp,.scc,.mg{grid-template-columns:1fr}.tg{grid-template-columns:1fr!important}.rt{font-size:28px}}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AQ Intelligence &mdash; ${esc(ORGS.join(' vs '))}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="edit-bar" id="edit-bar"><button class="edit-btn" id="edit-btn" onclick="toggleEdit()">&#9998; Edit Mode</button><button class="edit-btn edit-dl" id="dl-btn" onclick="dlEdit()">&#8595; Download Edited</button></div>
<div class="shell">
<nav class="sidenav"><div class="sidenav-logo"><div class="sidenav-logo-name">Emerald AI</div><div class="sidenav-logo-sub">AQ Intelligence</div></div>
<div class="nav-lbl">Report</div><a href="#exec" class="nav-a active">Executive Summary</a><a href="#method" class="nav-a">Methodology</a>
<div class="nav-lbl">Media Analysis</div><a href="#sov" class="nav-a">Share of Voice</a><a href="#tv" class="nav-a">TV Coverage</a><a href="#momentum" class="nav-a">Momentum</a><a href="#topics" class="nav-a">Topic Ownership</a><a href="#cit" class="nav-a">Citation Quality</a><a href="#em" class="nav-a">White-Space Gaps</a>
<div class="nav-lbl">Digital Presence</div><a href="#aeo" class="nav-a">AEO / LLM Visibility</a><a href="#social" class="nav-a">Social Media</a>${trendEvent?.detected?'<a href="#trend-social" class="nav-a">Trend Social</a>':''}
<div class="nav-lbl">Conclusions</div><a href="#score" class="nav-a">Scorecard</a><a href="#actions" class="nav-a">Action Matrix</a><a href="#appendix" class="nav-a">Appendix</a>
<div class="sidenav-footer">Generated: ${new Date().toISOString().slice(0,10)}<br>${navOrgs}CONFIDENTIAL</div></nav>
<main class="main">
<header class="rh" id="header"><div class="ey">Air Quality Media Intelligence &middot; India &middot; ${esc(DATE_FROM)} to ${esc(DATE_TO)}</div>
<h1 class="rt">Air Quality<br><span class="rti">TRIPLE Media Analytics</span></h1>
<div class="rm">Period: ${esc(DATE_FROM)} &rarr; ${esc(DATE_TO)} &middot; ${tot} AQ articles &middot; ${now}</div>
<div class="chips">${orgChips}</div>
<div class="dn"><strong>Publicly available data</strong> Insight linked to evidence &middot; ${now}</div>
${pptxFilename ? `<div style="margin-top:16px;display:flex;align-items:center;gap:12px;background:rgba(61,142,240,.08);border:1px solid rgba(61,142,240,.25);border-radius:6px;padding:12px 16px;font-size:13px"><div style="flex:1;color:var(--text)"><strong style="font-weight:600">PowerPoint version available.</strong> Open the <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">.pptx</code> file in the same folder.</div><div style="font-family:monospace;font-size:11px;color:var(--muted2);flex-shrink:0">📁 ${esc(pptxFilename)}</div></div>` : ''}
</header>

<section class="sec" id="exec"><div class="sh"><div class="se">Section 01</div><h2 class="st">Executive Summary</h2><div class="sd">Headline comparative findings across ${ORGS.length} organisations — media, LLM visibility, and social.</div><div class="sdiv"></div></div>
<div style="background:rgba(212,160,23,.07);border:1px solid rgba(212,160,23,.2);border-radius:8px;overflow:hidden;margin-bottom:4px">
<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;cursor:pointer;user-select:none" onclick="toggleExecDraft()">
<span style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--amber)">Draft Executive Summary <span style="font-weight:400;color:var(--muted2)">(AI-generated &mdash; review before sharing)</span></span>
<span id="exec-draft-icon" style="font-family:monospace;font-size:12px;color:var(--amber)">&#9660; Show draft</span>
</div>
<div id="exec-draft" style="display:none;padding:0 18px 18px">${execCards}</div>
</div></section>

<section class="sec" id="method"><div class="sh"><div class="se">Section 02</div><h2 class="st">Methodology</h2><div class="sd">How data was collected, filtered, and analysed. Serper News API for media coverage · Claude Haiku 4.5 for article classification · LLM probing (GPT-4o, Perplexity, Gemini) for AEO visibility · Social media: YouTube OAuth2, X/Twitter, Instagram, LinkedIn via Serper.</div><div class="sdiv"></div></div></section>

<section class="sec" id="sov"><div class="sh"><div class="se">Section 03</div><h2 class="st">Share of Voice</h2><div class="sd">AQ article counts per org, deduplicated, date-filtered.</div><div class="sdiv"></div></div>
<div class="mch"><div class="ch-hdr"><div style="font-size:13px;font-weight:600;color:var(--text)">All AQ coverage &mdash; ${tot} articles</div>
<div style="display:flex;gap:12px;flex-wrap:wrap">${ORGS.map((o,i)=>`<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted2)"><div style="width:12px;height:12px;border-radius:2px;background:${orgHex(i)}"></div>${esc(o)}</div>`).join('')}</div></div>
${sovBar()}
<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted2);margin-bottom:10px">${ORGS.map((o,i)=>`<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${orgHex(i)};margin-right:5px"></span>${esc(o)}: ${data[o].total}</div>`).join('')}</div>
</div>
<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:14px;font-family:monospace;font-size:11px;color:var(--muted2)"><strong style="color:var(--amber)">Reading this table:</strong> Total = all AQ-scoped articles across orgs at that outlet. Top orgs shows the three highest-coverage orgs as badges.</div>
<table class="nt"><thead><tr><th>Outlet</th><th>Total</th><th>Top orgs by coverage</th><th>Evidence</th></tr></thead><tbody>${outletRows()}</tbody></table></section>

<section class="sec" id="tv"><div class="sh"><div class="se">Section 03b</div><h2 class="st">TV Channel Coverage</h2>
<div class="sd">AQ article mentions specifically in English TV (NDTV, News18, India Today) and Hindi TV (Aaj Tak, India TV, ABP News) channels.</div><div class="sdiv"></div></div>
<div style="margin-bottom:16px">
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">English TV</div>
<table class="nt"><thead><tr><th>Org</th>${TV_CHANNELS_ENGLISH.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
${ORGS.map((org,i)=>`<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${TV_CHANNELS_ENGLISH.map(ch=>`<td style="font-family:monospace">${data[org]?.outletCounts[ch]||0}</td>`).join('')}</tr>`).join('')}
</tbody></table></div>
<div>
<div style="font-size:12px;font-weight:600;color:var(--muted2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Hindi TV</div>
<table class="nt"><thead><tr><th>Org</th>${TV_CHANNELS_HINDI.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
${ORGS.map((org,i)=>`<tr><td><span style="font-family:monospace;font-size:11px;font-weight:700;color:${orgHex(i)}">${esc(org)}</span></td>${TV_CHANNELS_HINDI.map(ch=>`<td style="font-family:monospace">${data[org]?.outletCounts[ch]||0}</td>`).join('')}</tr>`).join('')}
</tbody></table></div></section>

<section class="sec" id="momentum"><div class="sh"><div class="se">Section 04</div><h2 class="st">Coverage Momentum</h2>
<div class="sd">Weekly article volume per org. Taller = more articles. Dates parsed from Serper metadata.</div><div class="sdiv"></div></div>
<div class="mch"><div class="ch-hdr"><div><div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px">Weekly AQ volume</div><div style="font-size:11px;color:var(--muted)">${esc(DATE_FROM)} to ${esc(DATE_TO)} &middot; ${ORGS.map(o=>`${esc(o)}: ${data[o].total}`).join(' &middot; ')}</div></div>
<div style="display:flex;gap:12px;flex-wrap:wrap">${ORGS.map((o,i)=>`<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted2)"><div style="width:12px;height:12px;border-radius:2px;background:${orgHex(i)}"></div>${esc(o)}</div>`).join('')}</div></div>
<div class="wbars">${weekBars()}</div></div></section>

<section class="sec" id="topics"><div class="sh"><div class="se">Section 05</div><h2 class="st">Topic Ownership Map</h2>
<div class="sd">${TOPICS.length} AQ sub-topics including NCAP &middot; Policy &middot; PM2.5 Exposure &middot; Stubble Burning &middot; Vehicular Pollution &middot; Health Impact &middot; Brick Kilns &middot; Thermal Power Plants &middot; and more.</div><div class="sdiv"></div></div>
${clsNotice}
<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:20px;padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--muted2)">
<span><span class="ob badge-owns">Owns</span> = 5+ articles</span>
<span><span class="ob badge-con">Contests</span> = 2&ndash;4 articles</span>
<span><span class="ob badge-absent">Absent</span> = 0&ndash;1 articles</span>
</div>
${topicCards()}</section>

<section class="sec" id="cit"><div class="sh"><div class="se">Section 07</div><h2 class="st">Citation Quality</h2>
<div class="sd"><strong style="color:var(--good)">Data Cited</strong> = a specific number, statistic, or named report from this org is explicitly cited. <strong style="color:var(--muted2)">Named Mention</strong> = org is named but no specific data cited. <strong style="color:var(--muted)">Total</strong> = all articles retrieved by searching for this org&rsquo;s name &mdash; some may not directly name the org in the text (the search established the relevance connection; Claude classified each article individually). Sorted by Data Cited %.</div><div class="sdiv"></div></div>
${clsNotice}${citTable()}</section>

<section class="sec" id="em"><div class="sh"><div class="se">Section 08</div><h2 class="st">AQ Media White-Space Gaps</h2><div class="sd">Topics gaining traction in the <strong style="color:var(--text)">broader Indian AQ media landscape</strong> that the tracked organisations are <strong style="color:var(--warn)">not part of</strong> &mdash; identified by fetching general AQ news (no org name filter), removing any article that mentions a tracked org, then asking Claude to cluster the remaining articles into themes. These are genuine white-space opportunities: the AQ media conversation is active on these topics, but your orgs are absent. <strong>Gap signal</strong> = the evidence of absence. <strong>Opportunity</strong> = a concrete action to enter the conversation. Article links = source articles from the org-absent pool used as evidence.</div><div class="sdiv"></div></div>
${emergingCards}</section>

${SI.buildAEOHtml(aeoResults, ORGS)}
${SI.buildSocialHtml(siSocial, socialScores, ORGS)}
${trendEvent?.detected && trendSocialData?.length ? SI.buildTrendSocialHtml(trendEvent, trendSocialData, ORGS) : ''}
${socialERHtml}

<section class="sec" id="score"><div class="sh"><div class="se">Section 09</div><h2 class="st">Competitive Scorecard</h2><div class="sd">Organisations ranked by weighted composite: media · LLM visibility · social. Formula shown in full.</div><div class="sdiv"></div></div>
<div class="scf" style="margin-bottom:20px"><strong>Score</strong> = (SoV&times;0.25)+(Citation&times;0.25)+(AEO&times;0.30)+(Social/10&times;20)<br>
<span style="color:var(--muted)">${ORGS.map(o=>`${esc(o)}: ${data[o].sov}&times;0.25+${data[o].dataPct}&times;0.25+${data[o].aeo}&times;0.30+${data[o].social}&times;2=${data[o].score}`).join(' &middot; ')}</span></div>
<div class="scc">${scorecards}</div></section>

<section class="sec" id="actions"><div class="sh"><div class="se">Section 10</div><h2 class="st">Action Matrix</h2><div class="sd">Data-anchored recommendations per org, including AEO and social media actions.</div><div class="sdiv"></div></div>
<table class="at"><thead><tr><th>Org</th><th>Priority</th><th>Area</th><th>Action</th><th>Data rationale</th></tr></thead><tbody>${actionRows}</tbody></table></section>

<section class="sec" id="appendix"><div class="sh"><div class="se">Appendix</div><h2 class="st">Source Appendix</h2><div class="sd">All indexed articles. Verify any claim by following the URL.</div><div class="sdiv"></div></div>
${appendixSections}</section>

<footer class="rf">Generated by Emerald AI &middot; AQ Intelligence Platform v7 &middot; ${now}<br>
Data: Serper News API &middot; Claude Haiku 4.5 &middot; LLM AEO probing &middot; ${tot} articles &middot; ${esc(DATE_FROM)} to ${esc(DATE_TO)} &middot; Orgs: ${esc(ORGS.join(', '))}<br>
<strong style="color:var(--text)">CONFIDENTIAL</strong> &mdash; prepared for ${esc(CLIENT_NAME||'client')}</footer>
</main></div>
<script>
function td(id){var e=document.getElementById(id);if(e)e.classList.toggle('open');}
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
