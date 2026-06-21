'use strict';
/**
 * Test script: X/Twitter metrics extraction
 * Usage:
 *   SERPER_KEY=xxx CLAUDE_KEY=xxx SCREENSHOTONE_KEY=xxx node test-x-metrics.js
 * Or pass a custom tweet URL as first arg:
 *   node test-x-metrics.js https://x.com/CEEWIndia/status/1833168493472104641
 */

const axios = require('axios');

const TWEET_URL  = process.argv[2] || 'https://x.com/CEEWIndia/status/1833168493472104641';
const SERPER_KEY        = process.env.SERPER_KEY        || '';
const CLAUDE_KEY        = process.env.CLAUDE_KEY        || '';
const SCREENSHOTONE_KEY = process.env.SCREENSHOTONE_KEY || '';

function parseXNumber(s) {
  if (!s) return 0;
  s = String(s).replace(/,/g, '').trim();
  if (/k/i.test(s)) return Math.round(parseFloat(s) * 1000);
  if (/m/i.test(s)) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s) || 0;
}

function parseMetricsFromText(text) {
  const views   = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Vv]iews?/)?.[1]);
  const likes   = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Ll]ikes?/)?.[1]);
  const reposts = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*(?:[Rr]eposts?|[Rr]etweets?)/)?.[1]);
  const replies = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Rr]eplies?/)?.[1]);
  if (!views && !likes && !reposts && !replies) return null;
  return { likes, replies, reposts, views };
}

async function tryTextScrape() {
  if (!SERPER_KEY) { console.log('⚠  No SERPER_KEY — skipping text scrape'); return null; }
  console.log('\n── STEP 1: Text scrape via scrape.serper.dev ──');
  try {
    const res = await axios.post(
      'https://scrape.serper.dev',
      { url: TWEET_URL },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const text = res.data.text || res.data.content || '';
    console.log('Raw text (first 800 chars):\n' + text.slice(0, 800));
    const metrics = parseMetricsFromText(text);
    if (metrics) {
      console.log('\n✅ Metrics found in text:', metrics);
      return { ...metrics, source: 'text' };
    } else {
      console.log('\n❌ No metrics found in text — numbers like "142 Likes" not present');
      return null;
    }
  } catch (e) {
    console.log('❌ Text scrape error:', e.message);
    return null;
  }
}

async function tryScreenshotVision() {
  if (!SCREENSHOTONE_KEY) { console.log('⚠  No SCREENSHOTONE_KEY — skipping screenshot'); return null; }
  if (!CLAUDE_KEY)        { console.log('⚠  No CLAUDE_KEY — skipping vision'); return null; }

  console.log('\n── STEP 2: Screenshot → Claude vision ──');
  try {
    const shotUrl = `https://api.screenshotone.com/take?access_key=${SCREENSHOTONE_KEY}&url=${encodeURIComponent(TWEET_URL)}&format=jpg&viewport_width=820&viewport_height=560&block_ads=true&block_cookie_banners=true&delay=2`;
    console.log('Taking screenshot…');
    const imgRes = await axios.get(shotUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const base64 = Buffer.from(imgRes.data).toString('base64');
    console.log(`Screenshot size: ${Math.round(imgRes.data.byteLength / 1024)}KB`);

    console.log('Sending to Claude vision…');
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Look at this X/Twitter post screenshot. Extract the engagement counts. Return ONLY valid JSON: {"likes":0,"replies":0,"reposts":0,"views":0}. Use 0 for any metric not visible.' }
          ]
        }]
      },
      {
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const raw = claudeRes.data.content[0].text.trim();
    console.log('Claude raw response:', raw);
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const m = JSON.parse(match[0]);
      console.log('\n✅ Metrics from vision:', m);
      return { ...m, source: 'vision' };
    }
  } catch (e) {
    console.log('❌ Screenshot/vision error:', e.message);
  }
  return null;
}

async function main() {
  console.log('=== X Metrics Test ===');
  console.log('Tweet:', TWEET_URL);
  console.log('Keys:', {
    SERPER_KEY:        SERPER_KEY        ? '✓' : '✗ missing',
    CLAUDE_KEY:        CLAUDE_KEY        ? '✓' : '✗ missing',
    SCREENSHOTONE_KEY: SCREENSHOTONE_KEY ? '✓' : '✗ missing',
  });

  const metrics = (await tryTextScrape()) || (await tryScreenshotVision());

  console.log('\n══ FINAL RESULT ══');
  if (metrics) {
    const er = metrics.views > 0
      ? (((metrics.likes + metrics.replies + metrics.reposts) / metrics.views) * 100).toFixed(2)
      : null;
    console.log(`Source  : ${metrics.source}`);
    console.log(`Likes   : ${metrics.likes}`);
    console.log(`Replies : ${metrics.replies}`);
    console.log(`Reposts : ${metrics.reposts}`);
    console.log(`Views   : ${metrics.views}`);
    console.log(`ER      : ${er !== null ? er + '%' : 'N/A (no views data)'}`);
  } else {
    console.log('❌ Could not extract metrics via either method.');
    console.log('   → Text scrape: X likely returns JS-rendered page without metrics in raw text');
    console.log('   → Add SCREENSHOTONE_KEY + CLAUDE_KEY to try the vision fallback');
  }
}

main().catch(console.error);
