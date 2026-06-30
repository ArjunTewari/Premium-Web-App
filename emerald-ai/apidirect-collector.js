'use strict';
/**
 * apidirect-collector.js — Social AQ Presence via APIdirect.io
 *
 * Replaces: x-collector.js, instagram-collector.js, Serper social fallbacks
 * Platforms: LinkedIn · Twitter/X · Instagram
 * YouTube subscriber count also fetched here via APIdirect channels endpoint.
 *
 * Engagement Rate (ER) definitions:
 *   LinkedIn ER  = (likes + comments + shares) / posts * (if no followers)
 *                  OR (likes + comments + shares) / followers * 100
 *   Twitter ER   = (likes + replies + retweets) / followers * 100
 *   Instagram ER = (likes + comments) / followers * 100
 *
 * Returns per-org: { org, li, tw, ig, yt } where each platform block has:
 *   postCount, totalLikes, totalComments, totalShares/totalRetweets,
 *   totalViews, followers, er (%), topPosts [{url, snippet, likes, ...}]
 */

const axios = require('axios');

const BASE = 'https://apidirect.io/v1';
const AQ_KW = ['air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
               'smog', 'clean air', 'pollution', 'particulate', 'emission'];

function isAQ(text) {
  const t = (text || '').toLowerCase();
  return AQ_KW.some(k => t.includes(k));
}

async function apiFetch(endpoint, params, apiKey) {
  const url = `${BASE}/${endpoint}`;
  try {
    const { data } = await axios.get(url, {
      params,
      headers: { 'X-API-Key': apiKey },
      timeout: 18000,
    });
    return data;
  } catch (e) {
    const msg = e.response?.data?.error || e.message;
    throw new Error(`APIdirect /${endpoint}: ${msg}`);
  }
}

function er(engagement, followers, posts) {
  if (followers > 0) return +(engagement / followers * 100).toFixed(3);
  if (posts > 0) return +(engagement / posts).toFixed(2); // avg engagement/post fallback
  return 0;
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────
async function fetchLinkedIn(org, apiKey, cb) {
  const q = `"${org}" air quality India`;
  try {
    const r = await apiFetch('linkedin/posts', { query: q, page: 1 }, apiKey);
    const posts = (r.posts || []).filter(p => isAQ(`${p.title || ''} ${p.snippet || ''}`));
    const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
    const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
    const totalShares   = posts.reduce((s, p) => s + (p.shares   || 0), 0);
    const totalEngage   = totalLikes + totalComments + totalShares;
    const topPosts = [...posts]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0) + (b.shares || 0)) - ((a.likes || 0) + (a.comments || 0) + (a.shares || 0)))
      .slice(0, 5)
      .map(p => ({
        url:      p.url || '',
        snippet:  (p.snippet || p.title || '').slice(0, 250),
        author:   p.author || '',
        likes:    p.likes    || 0,
        comments: p.comments || 0,
        shares:   p.shares   || 0,
        date:     p.date     || '',
      }));
    const erVal = er(totalEngage, 0, posts.length); // no follower count w/o company URL
    cb?.(`  [APIdirect/LI] ${org}: ${posts.length} AQ posts, ${totalEngage} engagements`, posts.length > 0 ? 'ok' : 'warn');
    return { postCount: posts.length, totalLikes, totalComments, totalShares, totalViews: 0, followers: 0, er: erVal, topPosts };
  } catch (e) {
    cb?.(`  [APIdirect/LI] ${org}: ${e.message}`, 'warn');
    return { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  }
}

// ── Twitter / X ───────────────────────────────────────────────────────────────
async function fetchTwitter(org, twitterHandle, apiKey, cb) {
  try {
    let tweets = [];
    let followers = 0;

    if (twitterHandle) {
      const handle = twitterHandle.replace(/^@/, '');
      const [userRes, tweetsRes] = await Promise.allSettled([
        apiFetch('twitter/user', { username: handle }, apiKey),
        apiFetch('twitter/user/tweets', { username: handle, page: 1 }, apiKey),
      ]);
      if (userRes.status === 'fulfilled') followers = userRes.value?.user?.followers_count || 0;
      if (tweetsRes.status === 'fulfilled') tweets = tweetsRes.value?.tweets || [];
      // filter to AQ tweets from official handle
      tweets = tweets.filter(t => isAQ(`${t.title || ''} ${t.snippet || ''}`));
    } else {
      // fall back to keyword search
      const q = `"${org}" air quality India`;
      const r = await apiFetch('twitter/posts', { query: q, page: 1 }, apiKey);
      tweets = (r.posts || []);
      followers = tweets[0]?.author_followers || 0; // proxy from first result
    }

    const totalLikes    = tweets.reduce((s, t) => s + (t.likes    || 0), 0);
    const totalReplies  = tweets.reduce((s, t) => s + (t.replies  || 0), 0);
    const totalRetweets = tweets.reduce((s, t) => s + (t.retweets || 0), 0);
    const totalViews    = tweets.reduce((s, t) => s + (t.views    || 0), 0);
    const totalEngage   = totalLikes + totalReplies + totalRetweets;
    const topPosts = [...tweets]
      .sort((a, b) => ((b.likes || 0) + (b.replies || 0) + (b.retweets || 0)) - ((a.likes || 0) + (a.replies || 0) + (a.retweets || 0)))
      .slice(0, 5)
      .map(t => ({
        url:      t.url || '',
        snippet:  (t.snippet || t.title || '').slice(0, 250),
        author:   t.author || '',
        likes:    t.likes    || 0,
        replies:  t.replies  || 0,
        retweets: t.retweets || 0,
        views:    t.views    || 0,
        date:     t.date     || '',
      }));
    const erVal = er(totalEngage, followers, tweets.length);
    cb?.(`  [APIdirect/X] ${org}: ${tweets.length} tweets, ${followers.toLocaleString()} followers, ER=${erVal}%`, 'ok');
    return { postCount: tweets.length, totalLikes, totalReplies, totalRetweets, totalViews, followers, er: erVal, topPosts };
  } catch (e) {
    cb?.(`  [APIdirect/X] ${org}: ${e.message}`, 'warn');
    return { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  }
}

// ── Instagram ─────────────────────────────────────────────────────────────────
async function fetchInstagram(org, igHandle, apiKey, cb) {
  try {
    let posts = [];
    let followers = 0;
    const query = igHandle ? `${igHandle.replace(/^@/, '')} air quality` : `"${org}" air quality`;

    const [postsRes, userRes] = await Promise.allSettled([
      apiFetch('instagram/posts', { query, page: 1 }, apiKey),
      igHandle ? apiFetch('instagram/user', { username: igHandle.replace(/^@/, '') }, apiKey) : Promise.resolve(null),
    ]);
    if (postsRes.status === 'fulfilled') posts = postsRes.value?.posts || [];
    if (userRes.status === 'fulfilled' && userRes.value) followers = userRes.value?.user?.follower_count || 0;

    const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
    const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
    const totalViews    = posts.reduce((s, p) => s + (p.views    || 0), 0);
    const totalEngage   = totalLikes + totalComments;
    const topPosts = [...posts]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
      .slice(0, 5)
      .map(p => ({
        url:      p.url || '',
        snippet:  (p.snippet || p.title || '').slice(0, 250),
        author:   p.author || p.author_name || '',
        likes:    p.likes    || 0,
        comments: p.comments || 0,
        views:    p.views    || 0,
        date:     p.date     || '',
        isVideo:  !!p.is_video,
      }));
    const erVal = er(totalEngage, followers, posts.length);
    cb?.(`  [APIdirect/IG] ${org}: ${posts.length} posts, ${followers.toLocaleString()} followers, ER=${erVal}%`, 'ok');
    return { postCount: posts.length, totalLikes, totalComments, totalViews, followers, er: erVal, topPosts };
  } catch (e) {
    cb?.(`  [APIdirect/IG] ${org}: ${e.message}`, 'warn');
    return { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  }
}

// ── YouTube channel subscriber count (video ER stays in youtube-er.js) ────────
async function fetchYouTubeChannel(org, ytHandle, apiKey, cb) {
  try {
    const query = ytHandle ? ytHandle.replace(/^@/, '') : org;
    const r = await apiFetch('youtube/channels', { query }, apiKey);
    const ch = (r.channels || [])[0];
    if (!ch) return { subscribers: 0, channelTitle: '', channelUrl: '' };
    const subscribers = parseInt((ch.subscriber_count || '0').replace(/[^\d]/g, ''), 10) || 0;
    cb?.(`  [APIdirect/YT] ${org}: ${subscribers.toLocaleString()} subscribers`, 'ok');
    return { subscribers, channelTitle: ch.title || '', channelUrl: ch.url || '' };
  } catch (e) {
    cb?.(`  [APIdirect/YT] ${org} channel: ${e.message}`, 'warn');
    return { subscribers: 0, channelTitle: '', channelUrl: '' };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} cfg  - must include APIDIRECT_KEY
 * @param {string[]} selectedOrgs
 * @param {object} orgHandles  - { "OrgName": { twitter?: "@handle", instagram?: "@handle", youtube?: "@handle" } }
 * @param {Function} cb
 * @returns {Promise<Array>} one entry per org
 */
async function run(cfg, selectedOrgs, orgHandles = {}, cb) {
  const apiKey = cfg.APIDIRECT_KEY;
  if (!apiKey) {
    cb?.('  [APIdirect] No APIDIRECT_KEY — social collection skipped', 'warn');
    return selectedOrgs.map(org => ({
      org,
      li: { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      tw: { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      ig: { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      yt: { subscribers: 0, channelTitle: '', channelUrl: '' },
    }));
  }

  cb?.(`  APIdirect social collection: ${selectedOrgs.length} orgs (LI + X + IG + YT channel)…`);

  // Process 3 orgs at a time to stay within rate limits
  const results = [];
  for (let i = 0; i < selectedOrgs.length; i += 3) {
    const batch = selectedOrgs.slice(i, i + 3);
    const batchResults = await Promise.allSettled(batch.map(async org => {
      const handles = orgHandles[org] || {};
      const [li, tw, ig, yt] = await Promise.allSettled([
        fetchLinkedIn(org, apiKey, cb),
        fetchTwitter(org, handles.twitter || null, apiKey, cb),
        fetchInstagram(org, handles.instagram || null, apiKey, cb),
        fetchYouTubeChannel(org, handles.youtube || null, apiKey, cb),
      ]);
      return {
        org,
        li: li.status === 'fulfilled' ? li.value : { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
        tw: tw.status === 'fulfilled' ? tw.value : { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
        ig: ig.status === 'fulfilled' ? ig.value : { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
        yt: yt.status === 'fulfilled' ? yt.value : { subscribers: 0, channelTitle: '', channelUrl: '' },
      };
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  return results;
}

module.exports = { run };
