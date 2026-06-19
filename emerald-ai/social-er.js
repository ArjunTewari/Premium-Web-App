'use strict';
/**
 * social-er.js — Social Engagement Rate module
 * Platforms: Twitter/X, Instagram, LinkedIn via Apify REST API
 * ER formula: (Likes + Comments + Shares) × 100 / FollowerCount, averaged across AQ posts
 */

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ORG_HANDLES = {
  'WRI India':                                        { twitter: 'WRIIndia',           instagram: 'wri_india',           linkedin: 'wri-india' },
  'Air Pollution Action Group':                       { twitter: 'APAGIndia',          instagram: 'apagindia',           linkedin: 'air-pollution-action-group' },
  'Chintan Environmental Research and Action Group':  { twitter: 'ChintanIndia',       instagram: 'chintan_india',       linkedin: 'chintan-environmental-research-and-action-group' },
  'IIT Kanpur':                                       { twitter: 'IITKanpur',          instagram: 'iitkanpur',           linkedin: 'iit-kanpur' },
  'CSTEP':                                            { twitter: 'CSTEP_India',        instagram: 'cstep_india',         linkedin: 'cstep-india' },
  'IIT Delhi':                                        { twitter: 'IITDelhi',           instagram: 'iitdelhi',            linkedin: 'iit-delhi' },
  'Health Effects Institute':                         { twitter: 'HEIResearch',        instagram: 'heiresearch',         linkedin: 'health-effects-institute' },
  'ICCT':                                             { twitter: 'TheICCT',            instagram: 'theicct',             linkedin: 'icct' },
  'EPIC India':                                       { twitter: 'EPICIndia_',         instagram: 'epicindia_uchicago',  linkedin: 'epic-india' },
  'Council on Energy, Environment and Water':         { twitter: 'CEEWIndia',          instagram: 'ceewindia',           linkedin: 'council-on-energy-environment-and-water' },
  'Centre for Science and Environment':               { twitter: 'CSEIndia',           instagram: 'cseindia',            linkedin: 'centre-for-science-and-environment' },
  'Climate Trends':                                   { twitter: 'ClimateTrendsIN',    instagram: 'climatetrendsin',     linkedin: 'climate-trends' },
  'Sustainable Futures Collaborative':                { twitter: 'SFC_India',          instagram: 'sfc_india',           linkedin: 'sustainable-futures-collaborative' },
};

async function runApifyActor(actorId, input) {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');

  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${APIFY_TOKEN}`,
    input,
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  const runId = startRes.data.data.id;

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const statusRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`,
      { timeout: 10000 }
    );
    const status = statusRes.data.data.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Apify run ${status}`);
  }

  const dataRes = await axios.get(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`,
    { timeout: 15000 }
  );
  return dataRes.data;
}

async function fetchTwitterPosts(handle, dateFrom, dateTo) {
  try {
    const items = await runApifyActor('apidojo/tweet-scraper-v2', {
      searchTerms: [`from:${handle} air quality OR "air pollution" OR AQI OR PM2.5`],
      maxTweets: 10,
      start: dateFrom,
      end: dateTo,
    });
    return (items || []).slice(0, 5).map(t => ({
      platform: 'twitter',
      url: t.url || t.tweetUrl || '',
      text: t.text || t.fullText || '',
      date: t.createdAt || '',
      likes: t.likeCount || 0,
      comments: t.replyCount || 0,
      shares: t.retweetCount || 0,
      followerCount: t.author?.followers || t.authorFollowersCount || 0,
    }));
  } catch (e) {
    console.error(`[SocialER] Twitter fetch failed for ${handle}:`, e.message);
    return [];
  }
}

async function fetchInstagramPosts(handle, dateFrom) {
  try {
    const items = await runApifyActor('apify/instagram-scraper', {
      usernames: [handle],
      resultsLimit: 10,
      onlyPostsNewerThan: dateFrom,
    });
    const aqKeywords = /air quality|air pollution|aqi|pm2\.5|pm10|ncap|smog|particulate/i;
    return (items || [])
      .filter(p => aqKeywords.test(p.caption || p.alt || ''))
      .slice(0, 5)
      .map(p => ({
        platform: 'instagram',
        url: p.url || (p.shortCode ? `https://instagram.com/p/${p.shortCode}` : ''),
        text: p.caption || '',
        date: p.timestamp || '',
        likes: p.likesCount || 0,
        comments: p.commentsCount || 0,
        shares: 0,
        followerCount: p.ownerFollowersCount || p.followersCount || 0,
      }));
  } catch (e) {
    console.error(`[SocialER] Instagram fetch failed for ${handle}:`, e.message);
    return [];
  }
}

async function fetchLinkedInPosts(companySlug, dateFrom, dateTo) {
  try {
    const items = await runApifyActor('harvestapi/linkedin-profile-posts-scraper', {
      profileUrls: [`https://www.linkedin.com/company/${companySlug}/`],
      maxPosts: 10,
    });
    const aqKeywords = /air quality|air pollution|aqi|pm2\.5|pm10|ncap|smog|particulate/i;
    const fromDate = new Date(dateFrom);
    const toDate   = new Date(dateTo);
    return (items || [])
      .filter(p => {
        const postDate = new Date(p.postedAt || p.date || 0);
        return postDate >= fromDate && postDate <= toDate &&
               aqKeywords.test(p.text || p.content || '');
      })
      .slice(0, 5)
      .map(p => ({
        platform: 'linkedin',
        url: p.postUrl || p.url || '',
        text: p.text || p.content || '',
        date: p.postedAt || p.date || '',
        likes: p.likesCount || p.reactions || 0,
        comments: p.commentsCount || p.comments || 0,
        shares: 0,
        followerCount: p.companyFollowersCount || p.followersCount || 0,
      }));
  } catch (e) {
    console.error(`[SocialER] LinkedIn fetch failed for ${companySlug}:`, e.message);
    return [];
  }
}

function calcER(posts) {
  const withFollowers = posts.filter(p => p.followerCount > 0);
  if (!withFollowers.length) return 0;
  const total = withFollowers.reduce((sum, p) => {
    return sum + ((p.likes + p.comments + p.shares) * 100 / p.followerCount);
  }, 0);
  return parseFloat((total / withFollowers.length).toFixed(2));
}

function deriveInsight(posts) {
  if (!posts.length) return 'No posts found in this period';
  const totalLikes    = posts.reduce((s, p) => s + p.likes, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalShares   = posts.reduce((s, p) => s + p.shares, 0);
  const totalEng      = totalLikes + totalComments + totalShares;
  if (totalEng === 0) return 'No measurable engagement in this period';
  const sharePct   = totalShares   / totalEng;
  const commentPct = totalComments / totalEng;
  if (sharePct > 0.5)                        return 'Strong amplification — share-heavy';
  if (commentPct > 0.4)                      return 'High discussion — comment-driven';
  if (sharePct > 0.3 && commentPct > 0.2)   return 'Balanced reach and discussion';
  return 'Moderate engagement, primarily likes/reactions';
}

async function run(cfg, selectedOrgs, cb) {
  if (!process.env.APIFY_TOKEN) {
    cb?.('social-er', 'APIFY_TOKEN not set — skipping Social ER');
    return [];
  }

  cb?.('social-er', `Starting Social ER for ${selectedOrgs.length} orgs across Twitter, Instagram, LinkedIn…`);
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    const handles = ORG_HANDLES[orgName];
    if (!handles) {
      cb?.('social-er', `No handles found for ${orgName} — skipping`);
      continue;
    }
    cb?.('social-er', `Fetching ${orgName}…`);

    const [twPosts, igPosts, liPosts] = await Promise.allSettled([
      fetchTwitterPosts(handles.twitter,  cfg.DATE_FROM, cfg.DATE_TO),
      fetchInstagramPosts(handles.instagram, cfg.DATE_FROM),
      fetchLinkedInPosts(handles.linkedin, cfg.DATE_FROM, cfg.DATE_TO),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

    const allPosts = [...twPosts, ...igPosts, ...liPosts];
    const avgER = allPosts.length
      ? parseFloat(((calcER(twPosts) + calcER(igPosts) + calcER(liPosts)) / 3).toFixed(2))
      : 0;

    const bestPost = [...allPosts].sort((a, b) =>
      (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)
    )[0] || null;

    orgResults.push({
      org:           orgName,
      twitterER:     calcER(twPosts),
      instagramER:   calcER(igPosts),
      linkedinER:    calcER(liPosts),
      avgER,
      twitterPosts:  twPosts.length,
      instagramPosts: igPosts.length,
      linkedinPosts: liPosts.length,
      totalPosts:    allPosts.length,
      bestPost,
      insight:       deriveInsight(allPosts),
    });

    cb?.('social-er', `${orgName} done — avgER: ${avgER}%`);
  }

  orgResults.sort((a, b) => b.avgER - a.avgER);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.('social-er', 'Social ER complete');
  return orgResults;
}

function buildSocialERHtml(erResults) {
  if (!erResults?.length) return '';

  const MAX_POSTS_PER_PLATFORM = 5;
  const PLATFORMS = 3;

  const totalPostsAnalysed = erResults.reduce((s, r) => s + r.totalPosts, 0);
  const totalPostsPossible = erResults.length * PLATFORMS * MAX_POSTS_PER_PLATFORM;
  const highestER = erResults.reduce((best, r) => r.avgER > best.avgER ? r : best, erResults[0]);
  const sortedER  = [...erResults].map(r => r.avgER).filter(v => v > 0).sort((a, b) => a - b);
  const medianER  = sortedER.length
    ? parseFloat(sortedER[Math.floor(sortedER.length / 2)].toFixed(2))
    : 0;

  const statCards = [
    { label: 'Orgs tracked',          value: erResults.length,           unit: '',   color: '#8fa3b8' },
    { label: 'AQ posts analysed',     value: `${totalPostsAnalysed}/${totalPostsPossible}`, unit: '', color: '#4a9fd4' },
    { label: 'Highest avg ER',        value: highestER.avgER > 0 ? highestER.avgER + '%' : '—', unit: highestER.avgER > 0 ? highestER.org : '', color: '#4caf74' },
    { label: 'Median avg ER',         value: medianER > 0 ? medianER + '%' : '—',  unit: 'across ranked orgs', color: '#d4a843' },
  ].map(c => `
    <div style="flex:1;min-width:160px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.color};line-height:1">${c.value}</div>
      ${c.unit ? `<div style="font-size:11px;color:#5e7494;margin-top:5px">${c.unit}</div>` : ''}
    </div>`).join('');

  const maxAvgER = Math.max(...erResults.map(r => r.avgER), 0.01);
  const orgRows = erResults.map((r, i) => {
    const barPct = Math.round((r.avgER / maxAvgER) * 100);
    const rankLabel = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${r.rank}`;
    const twBar  = r.twitterER   > 0 ? Math.round((r.twitterER   / maxAvgER) * 100) : 0;
    const igBar  = r.instagramER > 0 ? Math.round((r.instagramER / maxAvgER) * 100) : 0;
    const liBar  = r.linkedinER  > 0 ? Math.round((r.linkedinER  / maxAvgER) * 100) : 0;
    const platformPill = (label, er, barW, col) => er > 0
      ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
           <span style="font-family:monospace;font-size:10px;color:#5e7494;width:64px;flex-shrink:0">${label}</span>
           <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
             <div style="height:100%;width:${barW}%;background:${col};border-radius:3px"></div>
           </div>
           <span style="font-family:monospace;font-size:11px;font-weight:700;color:${col};width:44px;text-align:right">${er}%</span>
         </div>`
      : `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
           <span style="font-family:monospace;font-size:10px;color:#5e7494;width:64px;flex-shrink:0">${label}</span>
           <span style="font-family:monospace;font-size:11px;color:#3a4a5e">No AQ posts</span>
         </div>`;
    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 20px;border-left:3px solid ${r.avgER > 0 ? '#4caf74' : '#252d40'}">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex-shrink:0;width:28px;font-family:monospace;font-size:14px;font-weight:700;color:#8fa3b8;padding-top:2px">${rankLabel}</div>
        <div style="flex:1;min-width:180px">
          <div style="font-family:monospace;font-size:12px;font-weight:700;color:#d8e4f0;margin-bottom:6px">${r.org}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="flex:1;height:7px;background:#1e2638;border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${barPct}%;background:#4caf74;border-radius:4px"></div>
            </div>
            <span style="font-family:monospace;font-size:16px;font-weight:700;color:${r.avgER > 0 ? '#4caf74' : '#3a4a5e'};width:52px;text-align:right">${r.avgER > 0 ? r.avgER + '%' : '—'}</span>
          </div>
          <div style="font-size:11px;color:#5e7494">${r.insight}</div>
        </div>
        <div style="flex-shrink:0;min-width:220px">
          ${platformPill('X/Twitter', r.twitterER, twBar, '#4a9fd4')}
          ${platformPill('Instagram', r.instagramER, igBar, '#c46ab3')}
          ${platformPill('LinkedIn', r.linkedinER, liBar, '#4a7fd4')}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:monospace;font-size:10px;color:#5e7494;margin-bottom:4px">Posts analysed</div>
          <div style="font-family:monospace;font-size:11px;color:#8fa3b8">${r.twitterPosts}<span style="color:#4a9fd4">T</span> / ${r.instagramPosts}<span style="color:#c46ab3">I</span> / ${r.linkedinPosts}<span style="color:#4a7fd4">L</span></div>
          ${r.bestPost ? `<div style="margin-top:6px;font-family:monospace;font-size:10px;color:#5e7494">Best post</div>
          <div style="font-family:monospace;font-size:10px;color:#4caf74">${r.bestPost.likes + r.bestPost.comments + r.bestPost.shares} engagements</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const platformLeaderboard = (label, icon, col, erKey, postsKey) => {
    const sorted = [...erResults].filter(r => r[erKey] > 0).sort((a, b) => b[erKey] - a[erKey]);
    if (!sorted.length) return `
      <div style="flex:1;min-width:200px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${icon} ${label}</span>
        </div>
        <div style="font-size:12px;color:#3a4a5e">No data collected</div>
      </div>`;
    const maxE = sorted[0][erKey];
    const rows = sorted.slice(0, 5).map((r, i) => {
      const pct = Math.round((r[erKey] / maxE) * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-family:monospace;font-size:10px;color:#5e7494;width:18px">${i+1}</span>
        <span style="font-family:monospace;font-size:11px;color:#d8e4f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.org.split(' ').slice(-1)[0]}</span>
        <div style="width:60px;height:4px;background:#1e2638;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:2px"></div>
        </div>
        <span style="font-family:monospace;font-size:11px;font-weight:700;color:${col};width:40px;text-align:right">${r[erKey]}%</span>
      </div>`;
    }).join('');
    return `
      <div style="flex:1;min-width:200px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${icon} ${label}</span>
          <span style="margin-left:auto;font-family:monospace;font-size:10px;color:#5e7494">top ${Math.min(sorted.length,5)}</span>
        </div>
        ${rows}
      </div>`;
  };

  return `
<section class="sec" id="social">
  <div class="sh">
    <div class="se">Section 08b</div>
    <h2 class="st">Social Engagement Rate</h2>
    <div class="sd">Real engagement rate (ER) per org across X/Twitter, Instagram, and LinkedIn — sourced via Apify. ER&nbsp;=&nbsp;(Likes&nbsp;+&nbsp;Comments&nbsp;+&nbsp;Shares)&nbsp;&times;&nbsp;100&nbsp;&divide;&nbsp;Followers, averaged across up to ${MAX_POSTS_PER_PLATFORM} AQ posts per platform. Instagram and LinkedIn shares are not publicly available and are excluded from those platform ERs.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  <div style="background:rgba(74,159,212,.06);border:1px solid rgba(74,159,212,.18);border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#8fa3b8;line-height:1.7">
    <strong style="color:#4a9fd4">Methodology:</strong> Apify actors fetch up to ${MAX_POSTS_PER_PLATFORM} posts per org per platform (apidojo/tweet-scraper-v2 &middot; apify/instagram-scraper &middot; harvestapi/linkedin-profile-posts-scraper), filtered to air quality content. ER is normalised 0&ndash;10 and used in the composite AQ Intelligence score.
  </div>

  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:32px">${orgRows}</div>

  <div style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:12px">Per-Platform Leaderboard</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    ${platformLeaderboard('X / Twitter', '𝕏', '#4a9fd4', 'twitterER', 'twitterPosts')}
    ${platformLeaderboard('Instagram',   '◉', '#c46ab3', 'instagramER', 'instagramPosts')}
    ${platformLeaderboard('LinkedIn',    'in', '#4a7fd4', 'linkedinER', 'linkedinPosts')}
  </div>
</section>`;
}

module.exports = { run, buildSocialERHtml };
