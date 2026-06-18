'use strict';
/**
 * social-er.js — Social Engagement Rate module
 * Platforms: Twitter/X, Instagram, LinkedIn via Apify REST API
 * ER formula: (Likes + Comments + Shares) × 100 / FollowerCount, averaged across AQ posts
 */

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Keys must match exactly what the UI/pipeline sends as org names
const ORG_HANDLES = {
  'WRI India':                                        { twitter: 'WRIIndia',          instagram: 'wri_india',           linkedin: 'wri-india' },
  'Air Pollution Action Group':                       { twitter: 'APAGIndia',         instagram: 'apagindia',           linkedin: 'air-pollution-action-group' },
  'Chintan Environmental Research and Action Group':  { twitter: 'ChintanIndia',      instagram: 'chintan_india',       linkedin: 'chintan-environmental-research-and-action-group' },
  'IIT Kanpur':                                       { twitter: 'IITKanpur',         instagram: 'iitkanpur',           linkedin: 'iit-kanpur' },
  'CSTEP':                                            { twitter: 'CSTEP_India',       instagram: 'cstep_india',         linkedin: 'cstep-india' },
  'IIT Delhi':                                        { twitter: 'IITDelhi',          instagram: 'iitdelhi',            linkedin: 'iit-delhi' },
  'Health Effects Institute':                         { twitter: 'HEIResearch',       instagram: 'heiresearch',         linkedin: 'health-effects-institute' },
  'ICCT':                                             { twitter: 'TheICCT',           instagram: 'theicct',             linkedin: 'icct' },
  'EPIC India':                                       { twitter: 'EPICIndia_',        instagram: 'epicindia_uchicago',  linkedin: 'epic-india' },
  'Council on Energy, Environment and Water':         { twitter: 'CEEWIndia',         instagram: 'ceewindia',           linkedin: 'council-on-energy-environment-and-water' },
  'Centre for Science and Environment':               { twitter: 'CSEIndia',          instagram: 'cseindia',            linkedin: 'centre-for-science-and-environment' },
  'Climate Trends':                                   { twitter: 'ClimateTrendsIN',   instagram: 'climatetrendsin',     linkedin: 'climate-trends' },
  'Sustainable Futures Collaborative':                { twitter: 'SFC_India',         instagram: 'sfc_india',           linkedin: 'sustainable-futures-collaborative' },
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

  const medals = ['🥇', '🥈', '🥉'];
  const rows = erResults.map((r, i) => {
    const medal = medals[i] || `#${r.rank}`;
    const barW  = Math.min(r.avgER * 10, 100);
    return `
      <tr style="border-bottom:1px solid #252d40">
        <td style="padding:10px 12px;font-weight:600;color:#d8e4f0">${medal} ${r.org}</td>
        <td style="padding:10px 12px">
          ${r.avgER > 0
            ? `<span style="font-weight:700;font-family:monospace;color:#4caf74">${r.avgER}%</span>
               <div style="height:4px;background:#1e2638;border-radius:2px;margin-top:4px;width:120px">
                 <div style="height:4px;width:${barW}%;background:#4caf74;border-radius:2px"></div>
               </div>`
            : '<span style="color:#5e7494">—</span>'}
        </td>
        <td style="padding:10px 12px;font-family:monospace;font-size:12px;color:#8fa3b8">${r.twitterER   > 0 ? r.twitterER   + '%' : '—'}</td>
        <td style="padding:10px 12px;font-family:monospace;font-size:12px;color:#8fa3b8">${r.instagramER > 0 ? r.instagramER + '%' : '—'}</td>
        <td style="padding:10px 12px;font-family:monospace;font-size:12px;color:#8fa3b8">${r.linkedinER  > 0 ? r.linkedinER  + '%' : '—'}</td>
        <td style="padding:10px 12px;font-size:11px;color:#5e7494">${r.twitterPosts}T / ${r.instagramPosts}IG / ${r.linkedinPosts}LI</td>
        <td style="padding:10px 12px;font-size:12px;color:#8fa3b8">${r.insight}</td>
      </tr>`;
  }).join('');

  return `
<section class="sec" id="social-er">
  <div class="sh">
    <div class="se">Social ER</div>
    <h2 class="st">Social Engagement Rate — Comparative Ranking</h2>
    <div class="sd">ER = (Likes + Comments + Shares) × 100 ÷ Followers, averaged across AQ posts. Instagram and LinkedIn shares not publicly available — excluded from those platform ERs.</div>
    <div class="sdiv"></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#111520">
    <thead>
      <tr style="background:#181e2e;border-bottom:2px solid #252d40">
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Organisation</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Avg ER</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Twitter ER</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Instagram ER</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">LinkedIn ER</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Posts</th>
        <th style="text-align:left;padding:10px 12px;color:#8fa3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Why</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

module.exports = { run, buildSocialERHtml };
