'use strict';
/**
 * social-er.js — Social Engagement Rate module
 * Platforms: Instagram, LinkedIn, YouTube via Apify REST API
 * ER formula: (Likes + Comments) × 100 / FollowerCount, averaged across AQ posts
 * YouTube shares not available; Twitter/X removed.
 */

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Keys must match exactly what the UI/pipeline sends as org names
// youtube: YouTube channel handle (the part after youtube.com/@)
const ORG_HANDLES = {
  'WRI India':                                        { instagram: 'wri_india',           linkedin: 'wri-india',                                          youtube: 'WRIIndia' },
  'Air Pollution Action Group':                       { instagram: 'apagindia',            linkedin: 'air-pollution-action-group',                         youtube: 'APAGIndia' },
  'Chintan Environmental Research and Action Group':  { instagram: 'chintan_india',        linkedin: 'chintan-environmental-research-and-action-group',    youtube: 'ChintanIndia' },
  'IIT Kanpur':                                       { instagram: 'iitkanpur',            linkedin: 'iit-kanpur',                                         youtube: 'IITKanpur' },
  'CSTEP':                                            { instagram: 'cstep_india',          linkedin: 'cstep-india',                                        youtube: 'CSTEPIndia' },
  'IIT Delhi':                                        { instagram: 'iitdelhi',             linkedin: 'iit-delhi',                                          youtube: 'IITDelhi' },
  'Health Effects Institute':                         { instagram: 'heiresearch',          linkedin: 'health-effects-institute',                           youtube: 'HEIResearch' },
  'ICCT':                                             { instagram: 'theicct',              linkedin: 'icct',                                               youtube: 'TheICCT' },
  'EPIC India':                                       { instagram: 'epicindia_uchicago',   linkedin: 'epic-india',                                         youtube: 'EPICIndia' },
  'Council on Energy, Environment and Water':         { instagram: 'ceewindia',            linkedin: 'council-on-energy-environment-and-water',            youtube: 'CEEWIndia' },
  'Centre for Science and Environment':               { instagram: 'cseindia',             linkedin: 'centre-for-science-and-environment',                 youtube: 'cseindia' },
  'CEEW':                                             { instagram: 'ceewindia',            linkedin: 'council-on-energy-environment-and-water',            youtube: 'CEEWIndia' },
  'CSE':                                              { instagram: 'cseindia',             linkedin: 'centre-for-science-and-environment',                 youtube: 'cseindia' },
  'Climate Trends':                                   { instagram: 'climatetrendsin',      linkedin: 'climate-trends',                                     youtube: 'ClimateTrendsIn' },
  'Sustainable Futures Collaborative':                { instagram: 'sfc_india',            linkedin: 'sustainable-futures-collaborative',                  youtube: 'SFCIndia' },
};

async function runApifyActor(actorId, input) {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');

  // Apify URL path uses ~ separator, not /
  const safeId = actorId.replace('/', '~');
  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/${safeId}/runs?token=${APIFY_TOKEN}`,
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

async function fetchInstagramPosts(handle, dateFrom, cb) {
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
    cb?.(`  [SocialER] Instagram error (${handle}): ${e.message}`, 'warn');
    return [];
  }
}

async function fetchLinkedInPosts(companySlug, dateFrom, dateTo, cb) {
  try {
    const items = await runApifyActor('apimaestro/linkedin-company-posts', {
      companyUrls: [`https://www.linkedin.com/company/${companySlug}/`],
    });
    const aqKeywords = /air quality|air pollution|aqi|pm2\.5|pm10|ncap|smog|particulate/i;
    const fromDate = new Date(dateFrom);
    const toDate   = new Date(dateTo);
    return (items || []).slice(0, 50)  // actor ignores maxPosts — cap here
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
    cb?.(`  [SocialER] LinkedIn error (${companySlug}): ${e.message}`, 'warn');
    return [];
  }
}

async function fetchYouTubePosts(channelHandle, dateFrom, dateTo, cb) {
  try {
    const items = await runApifyActor('streamers/youtube-scraper', {
      startUrls: [{ url: `https://www.youtube.com/@${channelHandle}/videos` }],
      maxResults: 10,
    });
    const aqKeywords = /air quality|air pollution|aqi|pm2\.5|pm10|ncap|smog|particulate/i;
    const fromDate = new Date(dateFrom);
    const toDate   = new Date(dateTo);
    return (items || [])
      .filter(v => {
        const vDate = new Date(v.date || 0);
        return vDate >= fromDate && vDate <= toDate &&
               aqKeywords.test(v.title || v.description || '');
      })
      .slice(0, 5)
      .map(v => ({
        platform: 'youtube',
        url: v.url || '',
        text: v.title || '',
        date: v.date || '',
        likes: v.likes || 0,
        comments: v.commentsCount || 0,
        shares: 0,
        followerCount: v.numberOfSubscribers || 0,
      }));
  } catch (e) {
    cb?.(`  [SocialER] YouTube error (${channelHandle}): ${e.message}`, 'warn');
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
    cb?.('  [SocialER] APIFY_TOKEN not set — skipping Social ER', 'warn');
    return [];
  }

  cb?.(`  Social ER: starting for ${selectedOrgs.length} orgs across Instagram, LinkedIn, YouTube…`);
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    const handles = ORG_HANDLES[orgName];
    if (!handles) {
      cb?.(`  [SocialER] No handles for "${orgName}" — skipping`, 'warn');
      continue;
    }
    cb?.(`  [SocialER] Fetching ${orgName}…`);

    const [igPosts, liPosts, ytPosts] = await Promise.allSettled([
      fetchInstagramPosts(handles.instagram, cfg.DATE_FROM, cb),
      fetchLinkedInPosts(handles.linkedin, cfg.DATE_FROM, cfg.DATE_TO, cb),
      fetchYouTubePosts(handles.youtube, cfg.DATE_FROM, cfg.DATE_TO, cb),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

    const allPosts = [...igPosts, ...liPosts, ...ytPosts];
    const avgER = allPosts.length
      ? parseFloat(((calcER(igPosts) + calcER(liPosts) + calcER(ytPosts)) / 3).toFixed(2))
      : 0;

    const bestPost = [...allPosts].sort((a, b) =>
      (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)
    )[0] || null;

    orgResults.push({
      org:            orgName,
      instagramER:    calcER(igPosts),
      linkedinER:     calcER(liPosts),
      youtubeER:      calcER(ytPosts),
      avgER,
      instagramPosts: igPosts.length,
      linkedinPosts:  liPosts.length,
      youtubePosts:   ytPosts.length,
      totalPosts:     allPosts.length,
      bestPost,
      insight:        deriveInsight(allPosts),
    });

    cb?.(`  [SocialER] ${orgName} done — IG:${calcER(igPosts)}% LI:${calcER(liPosts)}% YT:${calcER(ytPosts)}% avg:${avgER}%`, avgER > 0 ? 'ok' : 'warn');
  }

  orgResults.sort((a, b) => b.avgER - a.avgER);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.(`  Social ER complete`, 'ok');
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
    const igBar  = r.instagramER > 0 ? Math.round((r.instagramER / maxAvgER) * 100) : 0;
    const liBar  = r.linkedinER  > 0 ? Math.round((r.linkedinER  / maxAvgER) * 100) : 0;
    const ytBar  = r.youtubeER   > 0 ? Math.round((r.youtubeER   / maxAvgER) * 100) : 0;
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
          ${platformPill('Instagram', r.instagramER, igBar, '#c46ab3')}
          ${platformPill('LinkedIn',  r.linkedinER,  liBar, '#4a7fd4')}
          ${platformPill('YouTube',   r.youtubeER,   ytBar, '#e05c3a')}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:monospace;font-size:10px;color:#5e7494;margin-bottom:4px">Posts analysed</div>
          <div style="font-family:monospace;font-size:11px;color:#8fa3b8">${r.instagramPosts}<span style="color:#c46ab3">I</span> / ${r.linkedinPosts}<span style="color:#4a7fd4">L</span> / ${r.youtubePosts}<span style="color:#e05c3a">Y</span></div>
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
    <div class="sd">Real engagement rate (ER) per org across Instagram, LinkedIn, and YouTube — sourced via Apify. ER&nbsp;=&nbsp;(Likes&nbsp;+&nbsp;Comments)&nbsp;&times;&nbsp;100&nbsp;&divide;&nbsp;Followers/Subscribers, averaged across up to ${MAX_POSTS_PER_PLATFORM} AQ posts per platform.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  <div style="background:rgba(74,159,212,.06);border:1px solid rgba(74,159,212,.18);border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#8fa3b8;line-height:1.7">
    <strong style="color:#4a9fd4">Methodology:</strong> Apify actors fetch up to ${MAX_POSTS_PER_PLATFORM} posts per org per platform (apify/instagram-scraper &middot; apimaestro/linkedin-company-posts &middot; streamers/youtube-scraper), filtered to air quality content. ER is normalised 0&ndash;10 and used in the composite AQ Intelligence score.
  </div>

  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:32px">${orgRows}</div>

  <div style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:12px">Per-Platform Leaderboard</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    ${platformLeaderboard('Instagram', '◉',  '#c46ab3', 'instagramER', 'instagramPosts')}
    ${platformLeaderboard('LinkedIn',  'in', '#4a7fd4', 'linkedinER',  'linkedinPosts')}
    ${platformLeaderboard('YouTube',   '▶',  '#e05c3a', 'youtubeER',   'youtubePosts')}
  </div>
</section>`;
}

module.exports = { run, buildSocialERHtml };
