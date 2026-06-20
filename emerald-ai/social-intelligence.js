'use strict';
/**
 * Emerald AI — AEO Intelligence Generator
 * pipeline/social-intelligence.js
 *
 * Generates the AEO (LLM Visibility) section of the AQ report.
 * Social media is handled by social-er.js (Apify Engagement Rate).
 * Called from the main pipeline after news classification is done.
 *
 * Usage (from pipeline.js):
 *   const SI = require('./social-intelligence');
 *   const result = await SI.run(cfg, cb);
 *   // result.aeo        → { [org]: { score, mentions, llmBreakdown, topResponse } }
 *   // result.htmlBlocks → { aeoHtml }  ← inject into report
 *
 * Config keys used:
 *   cfg.ORGS            string[]  — org names to track
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
          mentions: count, total: queriesUsed.length
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
          mentions: count, total: queriesUsed.length
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
          mentions: count, total: queriesUsed.length
        };
        cb(`  Gemini → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })()
  ].filter(Boolean));

  // Aggregate total mentions across all LLMs; keep score for scorecard formula
  for (const org of orgs) {
    results[org].mentions = Object.values(results[org].llmBreakdown)
      .reduce((a, b) => a + b.mentions, 0);
    const maxPossible = queriesUsed.length * 3;
    results[org].score = Math.round(results[org].mentions / maxPossible * 100);
    cb(`  AEO total: ${org} = ${results[org].mentions} mentions across all LLMs`, 'ok');
  }

  results._queriesUsed = queriesUsed;
  return results;
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
/** Build a 2-row table (one row per org) for a platform */
/** AEO section HTML */
function buildAEOHtml(aeoResults, orgs) {
  const orgColorList = ['#3d8ef0','#e05c3a','#4caf74','#c9922a','#a371f7','#e05c5c','#14b8a6','#f97316','#8b5cf6','#06b6d4','#84cc16','#ef4444','#ec4899'];

  const maxMentions = Math.max(...orgs.map(o => (aeoResults[o]?.mentions || 0)), 1);

  // Sort by mentions descending, compute tied ranks
  const sortedOrgs = [...orgs]
    .map((org, oi) => ({ org, oi, m: aeoResults[org]?.mentions || 0 }))
    .sort((a, b) => b.m - a.m);
  let _lastM = null, _lastRank = 0;
  sortedOrgs.forEach((item, idx) => {
    if (item.m === _lastM) {
      item.rank = _lastRank;
    } else {
      item.rank = idx + 1;
      _lastRank = idx + 1;
      _lastM = item.m;
    }
  });

  const orgPanels = sortedOrgs.map(({ org, oi, m, rank }) => {
    const col = orgColorList[oi % orgColorList.length];
    const d = aeoResults[org] || { mentions: 0, llmBreakdown: {}, topResponse: '', questionResults: {} };
    const barW = Math.round((m / maxMentions) * 100);
    const isGood = m > 0;

    const llmRows = Object.entries(d.llmBreakdown).map(([llm, v]) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #252d40">
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8fa3b8;width:130px;flex-shrink:0">${escHtml(llm)}</span>
        <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
          <div style="height:100%;border-radius:3px;background:${col};width:${Math.round((v.mentions / Math.max(v.total, 1)) * 100)}%"></div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:${col};width:38px;text-align:right">${v.mentions}/${v.total}</span>
      </div>`).join('');

    const noticeColor = isGood ? 'rgba(76,175,116,.06)' : 'rgba(224,92,92,.06)';
    const noticeBorder = isGood ? 'rgba(76,175,116,.2)' : 'rgba(224,92,92,.2)';
    const noticeTextCol = isGood ? '#4caf74' : '#e05c5c';
    const noticeText = isGood
      ? `<strong style="color:${noticeTextCol}">Consistent presence.</strong> ${escHtml(org)} cited in ${m} LLM responses across all models.`
      : `<strong style="color:${noticeTextCol}">Visibility gap.</strong> ${escHtml(org)} not cited in any LLM responses.`;

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:20px;border-top:2px solid ${col};display:flex;gap:20px;align-items:flex-start">
      <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:#2e3a52;flex-shrink:0;width:36px;padding-top:2px">#${rank}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${col};margin-bottom:14px">${escHtml(org)}</div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          <div style="flex:1">
            <div style="font-family:'JetBrains Mono',monospace;font-size:32px;line-height:1;font-weight:700;color:${col}">${m}</div>
            <div style="font-size:12px;color:#8fa3b8;margin-top:4px;margin-bottom:8px">LLM mentions across all models</div>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
                <div style="height:100%;border-radius:3px;background:${col};width:${barW}%"></div>
              </div>
              <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">${barW}% vs top</span>
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px">${llmRows || '<div style="font-size:11px;color:#5e7494">No LLM keys provided</div>'}</div>
        ${d.topResponse ? `
        <div style="background:#0a0e17;border:1px solid #2e3a52;border-left:2px solid #c9922a;border-radius:0 5px 5px 0;padding:10px 12px;margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#8fa3b8;line-height:1.65">
          <div style="font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c9922a;margin-bottom:5px">Example LLM response</div>
          &ldquo;${escHtml(d.topResponse)}&rdquo;
        </div>` : ''}
        <div style="background:${noticeColor};border:1px solid ${noticeBorder};border-radius:6px;padding:10px 14px;font-size:12px;color:#8fa3b8;margin-top:12px;line-height:1.6">${noticeText}</div>
      </div>
    </div>`;
  }).join('');

  const queriesUsed = aeoResults._queriesUsed || AEO_QUESTIONS;

  // Split queries: those where ≥1 org was mentioned vs complete blanks
  const queriesWithHits = [];
  const queriesWithZero = [];
  queriesUsed.forEach((q, qi) => {
    const qKey = `Q${qi + 1}`;
    const anyMentioned = orgs.some(org =>
      (aeoResults[org]?.questionResults?.[qKey] || []).some(r => r.cited)
    );
    if (anyMentioned) queriesWithHits.push({ q, qi });
    else              queriesWithZero.push({ q, qi });
  });

  const makeQRow = ({ q, qi }) => {
    const qKey = `Q${qi + 1}`;
    const badges = orgs.map(org => {
      const qResults = aeoResults[org]?.questionResults?.[qKey] || [];
      const citedCount = qResults.filter(r => r.cited).length;
      const total = qResults.length;
      const col = total === 0 ? '#5e7494' : citedCount === total ? '#4caf74' : citedCount > 0 ? '#d4a017' : '#5e7494';
      const bg  = total === 0 ? '#1e2638' : citedCount === total ? 'rgba(76,175,116,.1)' : citedCount > 0 ? 'rgba(212,160,23,.1)' : '#1e2638';
      const bdr = total === 0 ? '#252d40' : citedCount === total ? 'rgba(76,175,116,.25)' : citedCount > 0 ? 'rgba(212,160,23,.25)' : '#252d40';
      const label = total === 0 ? `${org} —` : citedCount > 0 ? `${org} ✓ ${citedCount}/${total}` : `${org} ✗ 0/${total}`;
      return `<span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:${col};background:${bg};border:1px solid ${bdr};border-radius:3px;padding:1px 6px">${escHtml(label)}</span>`;
    }).join('');
    return `
    <div style="display:flex;gap:14px;padding:9px 0;border-bottom:1px solid #252d40;align-items:flex-start;font-size:12px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#c9922a;flex-shrink:0;width:18px;padding-top:2px">Q${qi + 1}</span>
      <div style="color:#8fa3b8;flex:1;line-height:1.55">${escHtml(q)} <span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:8px">${badges}</span></div>
    </div>`;
  };

  const hitRows  = queriesWithHits.map(makeQRow).join('');
  const gapBlock = queriesWithZero.length ? `
  <div style="background:rgba(224,92,92,.04);border:1px solid rgba(224,92,92,.15);border-radius:8px;padding:16px 18px;margin-top:16px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#e05c5c;margin-bottom:4px">
      Content &amp; Visibility Gaps — ${queriesWithZero.length} Topics with Zero Mentions
    </div>
    <div style="font-size:12px;color:#8fa3b8;margin-bottom:12px;line-height:1.65;max-width:680px">
      None of the tracked organisations appeared in LLM responses to these ${queriesWithZero.length} queries.
      This is a strategic opportunity — organisations that publish credible, citable content on these specific topics
      could own these AI citations. Right now, <strong style="color:#e05c5c">no one does</strong>.
    </div>
    ${queriesWithZero.map(({ q, qi }) => `
    <div style="display:flex;gap:14px;padding:8px 0;border-bottom:1px solid rgba(224,92,92,.08);align-items:flex-start">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#e05c5c;flex-shrink:0;width:18px;padding-top:2px">Q${qi + 1}</span>
      <div style="flex:1">
        <div style="font-size:12px;color:#8fa3b8;line-height:1.55;margin-bottom:4px">${escHtml(q)}</div>
        <div style="font-size:11px;color:#5e7494">→ Publish a report, brief, or data update addressing this specific question to capture AI visibility</div>
      </div>
    </div>`).join('')}
  </div>` : '';

  return `
<section style="margin-bottom:56px;scroll-margin-top:24px" id="aeo">
  <div style="margin-bottom:24px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#5e7494;margin-bottom:6px">AEO — LLM Visibility</div>
    <h2 style="font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:#d8e4f0;line-height:1.2">AI Engine Optimisation</h2>
    <div style="margin-top:8px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65">When someone asks an AI model about Indian air quality, which organisations does it cite? ${queriesUsed.length} discovery questions were sent to three LLMs. The metric is the raw number of LLM mentions — no score out of 100, no grades. Contributes 30% of the Competitive Scorecard.</div>
    <div style="width:40px;height:2px;background:#c9922a;margin:14px 0 0"></div>
  </div>
  <div style="background:rgba(201,146,42,.06);border:1px solid rgba(201,146,42,.18);border-radius:8px;padding:14px 18px;font-size:12px;color:#8fa3b8;margin-bottom:20px;line-height:1.7">
    <strong style="color:#c9922a">How AEO is measured:</strong> ${queriesUsed.length} discovery questions sent to GPT-4o mini, Perplexity Sonar, and Gemini 1.5 Flash. Each response that names the organisation = <strong style="color:#c9922a">1 mention</strong>. Total possible responses per org = ${queriesUsed.length * 3}.
  </div>
  <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">${orgPanels}</div>
  <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px;margin-bottom:12px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#c9922a;margin-bottom:2px">
      AEO Queries with Org Mentions (${queriesWithHits.length} of ${queriesUsed.length})
    </div>
    <div style="font-size:10px;color:#5e7494;margin-bottom:10px">Queries where at least one tracked organisation was cited by an LLM.</div>
    ${hitRows || '<div style="font-size:12px;color:#5e7494;padding:8px 0">No org mentions found across any queries.</div>'}
    ${gapBlock}
  </div>
  <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">GPT-4o mini · Perplexity Sonar · Gemini 1.5 Flash · ${queriesUsed.length} questions × 3 LLMs = ${queriesUsed.length * 3} responses per org</div>
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

  // 2. Build HTML
  cb('\nSTEP B — Building AEO HTML section...', 'head');
  const aeoHtml = buildAEOHtml(aeo, orgs);
  cb('  AEO HTML block built', 'ok');

  return { aeo, htmlBlocks: { aeoHtml } };
}

module.exports = { run, runAEO, buildAEOHtml };
