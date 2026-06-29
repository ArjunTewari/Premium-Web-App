'use strict';
/**
 * test-social.js — Multi-platform social intelligence via APIDirectio
 *
 * Platforms: Twitter/X · Instagram (org profile) · LinkedIn · YouTube
 * Auth:      X-API-Key header
 * Pricing:   $0.006/page · 50 free/month per endpoint
 *
 * Flow per org:
 *   1. Fetch all 4 platforms in parallel from APIDirectio
 *   2. Filter by report date window (client-side on `date` field)
 *   3. Classify with Claude Haiku — keep only AQ-relevant posts
 *   4. Display metrics
 */

// Load .env
try {
  const fs = require('fs'), path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch {}

const axios = require('axios');

const ORGS      = ['CEEW', 'CSE India'];
const DATE_FROM = '2026-02-01';
const DATE_TO   = '2026-05-01';
const API_BASE  = 'https://apidirect.io';

// Official account handles per platform.
// Twitter  → username without @  (used for /v1/twitter/user/tweets)
// LinkedIn → full company page URL (used for /v1/linkedin/company/posts)
// Instagram → username           (used for /v1/instagram/user/posts)
// Verify / add slugs before running for new orgs.
const ORG_SOCIAL = {
  'CEEW': {
    twitter:   'CEEWIndia',
    linkedin:  'https://www.linkedin.com/company/council-on-energy-environment-and-water/',
    instagram: 'ceewindia',
    youtube:   'UCNF-vGnm1jdA_jhrIpk84Tg',
  },
  'CSE India': {
    twitter:   'cseindia',
    linkedin:  'https://www.linkedin.com/company/centre-for-science-and-environment-new-delhi/',
    instagram: 'cseindia',
    youtube:   null,
  },
  'WRI India': {
    twitter:   'WRIIndia',
    linkedin:  'https://www.linkedin.com/company/wri-india',
    instagram: 'wriindia',
  },
  'CSTEP': {
    twitter:   'CSTEP_India',
    linkedin:  'https://www.linkedin.com/company/cstep',
    instagram: 'cstep_india',
  },
  'Air Pollution Action Group': {
    twitter:   'APAGIndia',
    linkedin:  'https://www.linkedin.com/company/air-pollution-action-group',
    instagram: 'apagindia',
  },
  'Chintan': {
    twitter:   'ChintanIndia',
    linkedin:  'https://www.linkedin.com/company/chintan-environmental-research-and-action-group',
    instagram: 'chintanindia',
  },
  'IIT Delhi': {
    twitter:   'IITDelhi',
    linkedin:  'https://www.linkedin.com/school/indian-institute-of-technology-delhi',
    instagram: 'iitdelhi',
  },
  'IIT Kanpur': {
    twitter:   'IITKanpur',
    linkedin:  'https://www.linkedin.com/school/indian-institute-of-technology-kanpur',
    instagram: 'iitkanpur',
  },
  'Health Effects Institute': {
    twitter:   'HealthEffects',
    linkedin:  'https://www.linkedin.com/company/health-effects-institute',
    instagram: 'healtheffectsinstitute',
  },
  'ICCT': {
    twitter:   'TheICCT',
    linkedin:  'https://www.linkedin.com/company/international-council-on-clean-transportation',
    instagram: 'theicct',
  },
  'EPIC India': {
    twitter:   'EPICIndia',
    linkedin:  'https://www.linkedin.com/company/epic-india',
    instagram: 'epic_india',
  },
  'Climate Trends': {
    twitter:   'ClimateHound',
    linkedin:  'https://www.linkedin.com/company/climate-trends',
    instagram: 'climatetrendsindia',
  },
  'Sustainable Futures Collaborative': {
    twitter:   'SFCIndia',
    linkedin:  'https://www.linkedin.com/company/sustainable-futures-collaborative',
    instagram: 'sfc_india',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function inPeriod(dateStr) {
  if (!dateStr) return true;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true;
    return d >= new Date(DATE_FROM) && d <= new Date(DATE_TO);
  } catch {
    return true;
  }
}

async function apiFetch(path, params, apiKey, timeout = 30000) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(String(k), String(v)));
  const res = await axios.get(url.toString(), {
    headers: { 'X-API-Key': apiKey },
    timeout,
  });
  return res.data;
}

// ── Claude Haiku AQ classifier ─────────────────────────────────────────────

async function classifyPost(text, claudeKey) {
  if (!text || !claudeKey) return false;
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system:     'You classify social media posts. Reply with only YES or NO.',
      messages: [{
        role:    'user',
        content: `Is this post about air quality, air pollution, AQI, PM2.5, smog, clean air, emissions, or environmental air health?\n\nPost: "${text.slice(0, 500)}"\n\nAnswer YES or NO only.`,
      }],
    }, {
      headers: {
        'x-api-key':         claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 15000,
    });
    return res.data.content?.[0]?.text?.trim().toUpperCase() === 'YES';
  } catch {
    return false;
  }
}

async function filterAQPosts(posts, claudeKey, label) {
  if (!claudeKey) {
    console.log(`    ⚠ No CLAUDE_KEY — skipping Haiku (${label})`);
    return posts;
  }
  if (!posts.length) return [];
  const aq = [];
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    const flags = await Promise.all(batch.map(p => classifyPost(p.text, claudeKey)));
    flags.forEach((isAQ, j) => { if (isAQ) aq.push(batch[j]); });
    if (i + 5 < posts.length) await new Promise(r => setTimeout(r, 400));
  }
  return aq;
}

// ── Platform fetchers ──────────────────────────────────────────────────────

// Fetches tweets FROM the org's own account (not mentions of the org)
async function fetchTwitter(handle, apiKey) {
  const data = await apiFetch('/v1/twitter/user/tweets', {
    username: handle,
    pages:    3,
  }, apiKey);
  return (data.tweets || [])
    .filter(p => inPeriod(p.date))
    .map(p => ({
      platform: 'Twitter/X',
      text:     p.snippet || p.title || '',
      url:      p.url     || '',
      date:     p.date    || '',
      author:   p.author  || handle,
      likes:    p.likes     || 0,
      retweets: p.retweets  || 0,
      replies:  p.replies   || 0,
      views:    p.views     || 0,
    }));
}

// Uses the org's own IG handle — returns their profile posts directly
async function fetchInstagram(handle, apiKey) {
  const data = await apiFetch('/v1/instagram/user/posts', {
    username: handle,
    pages:    3,
  }, apiKey, 60000);
  return (data.posts || [])
    .filter(p => inPeriod(p.date))
    .map(p => ({
      platform: 'Instagram',
      text:     p.snippet || p.title || '',
      url:      p.url     || '',
      date:     p.date    || '',
      author:   p.author  || handle,
      likes:    p.likes    || 0,
      comments: p.comments || 0,
      views:    p.views    || 0,
    }));
}

// Fetches posts FROM the org's own LinkedIn company page
async function fetchLinkedIn(companyUrl, apiKey) {
  const data = await apiFetch('/v1/linkedin/company/posts', {
    url:  companyUrl,
    page: 1,
  }, apiKey);
  return (data.posts || [])
    .filter(p => inPeriod(p.date))
    .map(p => ({
      platform: 'LinkedIn',
      text:     p.text || p.snippet || '',
      url:      p.url  || '',
      date:     p.date || '',
      author:   p.author || '',
      likes:    p.likes    || 0,
      comments: p.comments || 0,
      shares:   p.shares   || 0,
    }));
}

// Uses YouTube Data API v3 to fetch videos from the org's own channel.
// Skipped entirely when youtube channel ID is null/undefined.
async function fetchYouTube(channelId, youtubeKey) {
  const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: {
      channelId,
      type:           'video',
      part:           'snippet',
      maxResults:     25,
      order:          'date',
      publishedAfter:  new Date(DATE_FROM).toISOString(),
      publishedBefore: new Date(DATE_TO).toISOString(),
      key:            youtubeKey,
    },
    timeout: 15000,
  });
  return (res.data.items || []).map(item => ({
    platform: 'YouTube',
    text:     (item.snippet?.title || '') + ' ' + (item.snippet?.description || '').slice(0, 200),
    url:      `https://www.youtube.com/watch?v=${item.id?.videoId}`,
    date:     item.snippet?.publishedAt || '',
    author:   item.snippet?.channelTitle || '',
    views:    0,
  }));
}

// ── Display ────────────────────────────────────────────────────────────────

function displayPosts(posts) {
  if (!posts.length) { console.log('    (none)\n'); return; }
  posts.forEach(p => {
    console.log(`    ${p.text.slice(0, 85)}`);
    if (p.url)  console.log(`    URL      : ${p.url}`);
    if (p.date) console.log(`    Date     : ${p.date}`);
    const m = [];
    if (p.likes    > 0) m.push(`${p.likes} likes`);
    if (p.retweets > 0) m.push(`${p.retweets} RTs`);
    if (p.replies  > 0) m.push(`${p.replies} replies`);
    if (p.comments > 0) m.push(`${p.comments} comments`);
    if (p.shares   > 0) m.push(`${p.shares} shares`);
    if (p.views    > 0) m.push(`${p.views.toLocaleString()} views`);
    if (m.length) console.log(`    Metrics  : ${m.join(' · ')}`);
    console.log();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const API_KEY     = process.env.APIDIRECT_KEY;
  const CLAUDE_KEY  = process.env.CLAUDE_KEY;
  const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

  console.log('=== Social Intelligence — APIDirectio + YouTube Data API ===');
  console.log(`Orgs     : ${ORGS.join(', ')}`);
  console.log(`Period   : ${DATE_FROM} → ${DATE_TO}`);
  console.log(`APIDir   : ${API_KEY ? '✓' : '✗ (set APIDIRECT_KEY in .env)'}  YouTube: ${YOUTUBE_KEY ? '✓' : '✗'}  Haiku: ${CLAUDE_KEY ? '✓' : '✗'}\n`);

  if (!API_KEY) { console.error('APIDIRECT_KEY not set'); process.exit(1); }

  for (const org of ORGS) {
    const handles = ORG_SOCIAL[org] || {};
    console.log(`\n══ ${org} ${'═'.repeat(Math.max(0, 44 - org.length))}`);
    console.log(`    X: @${handles.twitter || '?'}  LI: ${handles.linkedin ? '✓' : '✗'}  IG: @${handles.instagram || '?'}  YT: ${handles.youtube ? '✓' : '—'}`);

    if (!handles.twitter && !handles.linkedin && !handles.instagram) {
      console.log('  ⚠ No handles configured — add to ORG_SOCIAL map'); continue;
    }

    // Step 1: fetch all platforms in parallel
    const [tweets, igPosts, liPosts, ytPosts] = await Promise.all([
      handles.twitter
        ? fetchTwitter(handles.twitter, API_KEY).catch(e => {
            console.log(`  ⚠ Twitter: ${e.response?.data?.error || e.message}`); return [];
          })
        : Promise.resolve([]),
      handles.instagram
        ? fetchInstagram(handles.instagram, API_KEY).catch(e => {
            console.log(`  ⚠ Instagram: ${e.response?.data?.error || e.message}`); return [];
          })
        : Promise.resolve([]),
      handles.linkedin
        ? fetchLinkedIn(handles.linkedin, API_KEY).catch(e => {
            console.log(`  ⚠ LinkedIn: ${e.response?.data?.error || e.message}`); return [];
          })
        : Promise.resolve([]),
      handles.youtube && YOUTUBE_KEY
        ? fetchYouTube(handles.youtube, YOUTUBE_KEY).catch(e => {
            console.log(`  ⚠ YouTube: ${e.response?.data?.error?.message || e.message}`); return [];
          })
        : Promise.resolve([]),
    ]);

    console.log(`  Raw in period : X=${tweets.length}  IG=${igPosts.length}  LI=${liPosts.length}  YT=${ytPosts.length}`);

    // Step 2: Haiku AQ classification (sequential to avoid rate limit burst)
    const aqTweets = await filterAQPosts(tweets,  CLAUDE_KEY, 'Twitter');
    const aqIG     = await filterAQPosts(igPosts,  CLAUDE_KEY, 'Instagram');
    const aqLI     = await filterAQPosts(liPosts,  CLAUDE_KEY, 'LinkedIn');
    const aqYT     = await filterAQPosts(ytPosts,  CLAUDE_KEY, 'YouTube');

    console.log(`  AQ confirmed  : X=${aqTweets.length}  IG=${aqIG.length}  LI=${aqLI.length}  YT=${aqYT.length}\n`);

    if (aqTweets.length) { console.log(`  ── Twitter/X (${aqTweets.length} AQ posts) ──`); displayPosts(aqTweets); }
    if (aqIG.length)     { console.log(`  ── Instagram (${aqIG.length} AQ posts) ──`);     displayPosts(aqIG);     }
    if (aqLI.length)     { console.log(`  ── LinkedIn (${aqLI.length} AQ posts) ──`);      displayPosts(aqLI);     }
    if (aqYT.length)     { console.log(`  ── YouTube (${aqYT.length} AQ videos) ──`);      displayPosts(aqYT);     }

    const totalAQ = aqTweets.length + aqIG.length + aqLI.length + aqYT.length;
    if (!totalAQ) console.log('  No AQ content found across any platform in this period.\n');
  }

  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
