'use strict';
/**
 * Emerald AI — AEO Intelligence Generator
 * pipeline/social-intelligence.js
 *
 * Generates the AEO (LLM Visibility) section of the AQ report.
 * Social media is handled by social-er.js (Serper-based engagement rate).
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

// Word-boundary org mention check — prevents "IIT" matching inside "IITM" etc.
function orgMentioned(text, org) {
  const escaped = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

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

  const hasAEO = cfg.OPENAI_KEY || cfg.PERPLEXITY_KEY || cfg.APIDIRECT_KEY || cfg.CLAUDE_KEY;
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
            { model: 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'system', content: 'Reply in 1-2 sentences maximum. List only organisation names, no explanations.' }, { role: 'user', content: q }] },
            { headers: { 'Authorization': `Bearer ${cfg.OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      let gptErrors = 0;
      const texts = responses.map((r, i) => {
        if (r.status === 'rejected') {
          gptErrors++;
          if (i === 0) cb(`  GPT-4o error: ${r.reason?.response?.data?.error?.message || r.reason?.message || 'unknown'}`, 'warn');
          return '';
        }
        return r.value.data.choices[0].message.content || '';
      });
      if (gptErrors > 0) cb(`  GPT-4o mini: ${gptErrors}/${queriesUsed.length} calls failed`, 'warn');
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = orgMentioned(text, org);
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'GPT-4o mini', cited: mentioned, text });
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
            { model: 'sonar', max_tokens: 300, messages: [{ role: 'system', content: 'Reply in 1-2 sentences maximum. List only organisation names, no explanations.' }, { role: 'user', content: q }] },
            { headers: { 'Authorization': `Bearer ${cfg.PERPLEXITY_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      let pplxErrors = 0;
      const texts = responses.map((r, i) => {
        if (r.status === 'rejected') {
          pplxErrors++;
          if (i === 0) cb(`  Perplexity error: ${r.reason?.response?.data?.error?.message || r.reason?.message || 'unknown'}`, 'warn');
          return '';
        }
        return r.value.data.choices[0].message.content || '';
      });
      if (pplxErrors > 0) cb(`  Perplexity: ${pplxErrors}/${queriesUsed.length} calls failed`, 'warn');
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = orgMentioned(text, org);
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'Perplexity', cited: mentioned, text });
        });
        results[org].llmBreakdown['Perplexity'] = {
          mentions: count, total: queriesUsed.length
        };
        cb(`  Perplexity → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })(),

    // Claude Haiku
    cfg.CLAUDE_KEY && (async () => {
      cb(`  Probing Claude Haiku — ${queriesUsed.length} questions...`);
      const responses = await Promise.allSettled(
        queriesUsed.map(q =>
          axios.post('https://api.anthropic.com/v1/messages',
            { model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: 'Reply in 1-2 sentences maximum. List only organisation names, no explanations.', messages: [{ role: 'user', content: q }] },
            { headers: { 'x-api-key': cfg.CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
          )
        )
      );
      let claudeErrors = 0;
      const texts = responses.map((r, i) => {
        if (r.status === 'rejected') {
          claudeErrors++;
          if (i === 0) cb(`  Claude error: ${r.reason?.response?.data?.error?.message || r.reason?.message || 'unknown'}`, 'warn');
          return '';
        }
        return r.value.data.content?.[0]?.text || '';
      });
      if (claudeErrors > 0) cb(`  Claude Haiku: ${claudeErrors}/${queriesUsed.length} calls failed`, 'warn');
      for (const org of orgs) {
        let count = 0;
        texts.forEach((text, qi) => {
          const mentioned = orgMentioned(text, org);
          if (mentioned) {
            count++;
            if (!results[org].topResponse) results[org].topResponse = text.slice(0, 220);
          }
          results[org].questionResults[`Q${qi + 1}`].push({ llm: 'Claude', cited: mentioned, text });
        });
        results[org].llmBreakdown['Claude'] = { mentions: count, total: queriesUsed.length };
        cb(`  Claude → ${org}: ${count}/${queriesUsed.length}`, count > 0 ? 'ok' : 'warn');
      }
    })(),
  ].filter(Boolean));

  // Aggregate total mentions across all LLMs; keep score for scorecard formula
  for (const org of orgs) {
    results[org].mentions = Object.values(results[org].llmBreakdown)
      .reduce((a, b) => a + b.mentions, 0);
    const activeLlms = [cfg.OPENAI_KEY, cfg.PERPLEXITY_KEY, cfg.APIDIRECT_KEY].filter(Boolean).length || 1;
    const maxPossible = queriesUsed.length * activeLlms;
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
function buildAEOHtml(aeoResults, orgs, queriesOverride) {
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

  const queriesUsed = queriesOverride || aeoResults._queriesUsed || AEO_QUESTIONS;

  // ── Summary table: orgs as rows, LLMs as columns ─────────────────────────
  const allLlms = [...new Set(
    orgs.flatMap(o => Object.keys(aeoResults[o]?.llmBreakdown || {}))
  )];

  const summaryTable = `<div style="border:1px solid #252d40;border-radius:8px;margin-bottom:20px;overflow:hidden"><div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr style="background:#181e2e">
        <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fa3b8;white-space:nowrap">Rank</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fa3b8">Org</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;white-space:nowrap">Total</th>
        ${allLlms.map(llm => `<th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fa3b8;white-space:nowrap">${escHtml(llm)}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${sortedOrgs.map(({ org, oi, m, rank }) => {
        const col = orgColorList[oi % orgColorList.length];
        const d = aeoResults[org] || { llmBreakdown: {} };
        const maxQ = queriesUsed ? queriesUsed.length : 1;
        return `<tr style="border-top:1px solid #252d40">
          <td style="padding:10px 14px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${m > 0 ? '#8fa3b8' : '#6b7e9a'}">${m > 0 ? `#${rank}` : '—'}</td>
          <td style="padding:10px 14px"><span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${col}">${escHtml(org)}</span></td>
          <td style="padding:10px 14px;text-align:center">
            <span style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:700;color:${col}">${m}</span>
          </td>
          ${allLlms.map(llm => {
            const v = d.llmBreakdown?.[llm] || { mentions: 0, total: maxQ };
            const pct = Math.round((v.mentions / Math.max(v.total, 1)) * 100);
            const tc = v.mentions === v.total && v.total > 0 ? '#4caf74' : v.mentions > 0 ? '#d4a017' : '#7d90aa';
            return `<td style="padding:10px 14px;text-align:center">
              <span style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;color:${tc}">${v.mentions}/${v.total}</span>
            </td>`;
          }).join('')}
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div></div>`;

  // ── Q×Org matrix table ────────────────────────────────────────────────────
  const llmLinks = {
    'GPT-4o mini':      (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    'Perplexity':       (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
    'Claude':           (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  };

  const qMatrixRows = queriesUsed.map((q, qi) => {
    const qKey = `Q${qi + 1}`;
    const anyMentioned = orgs.some(o => (aeoResults[o]?.questionResults?.[qKey] || []).some(r => r.cited));

    // Collect unique LLM responses for this query
    const llmResponsesMap = {};
    for (const org of orgs) {
      for (const r of (aeoResults[org]?.questionResults?.[qKey] || [])) {
        if (r.text && !llmResponsesMap[r.llm]) llmResponsesMap[r.llm] = r.text;
      }
    }
    const llmResponseBlocks = Object.entries(llmResponsesMap).map(([llm, text]) => {
      let highlighted = escHtml(text);
      for (const org of orgs) {
        const re = new RegExp(escHtml(org).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        highlighted = highlighted.replace(re, `<strong style="color:#c9922a">$&</strong>`);
      }
      const openHref = llmLinks[llm] ? llmLinks[llm](q) : '#';
      return `<div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494">${escHtml(llm)}</span>
          <a href="${openHref}" target="_blank" rel="noopener" style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#3d8ef0;text-decoration:none">↗ open</a>
        </div>
        <div style="font-size:11px;color:#8fa3b8;line-height:1.6;background:#0a0e17;border:1px solid #252d40;border-radius:4px;padding:8px 10px;white-space:pre-wrap">${highlighted}</div>
      </div>`;
    }).join('');

    const orgCells = orgs.map(org => {
      const qResults = aeoResults[org]?.questionResults?.[qKey] || [];
      const cited = qResults.filter(r => r.cited).length;
      const total = qResults.length;
      if (total === 0) return `<td style="padding:8px 12px;text-align:center;border-left:1px solid #252d40"><span style="color:#2e3a52;font-size:12px">—</span></td>`;
      const tc  = cited === total ? '#4caf74' : cited > 0 ? '#d4a017' : '#5e7494';
      const sym = cited > 0 ? '✓' : '✗';
      return `<td style="padding:8px 12px;text-align:center;border-left:1px solid #252d40">
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:${tc}">${sym} ${cited}/${total}</span>
      </td>`;
    }).join('');

    const detailsBlock = llmResponseBlocks
      ? `<details style="margin-top:4px"><summary style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5e7494;cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px"><span style="color:#c9922a">▶</span> responses</summary><div style="margin-top:6px;border-left:2px solid #252d40;padding-left:10px">${llmResponseBlocks}</div></details>`
      : '';

    return `<tr style="border-top:1px solid #252d40${anyMentioned ? '' : ';opacity:.5'}">
      <td style="padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${anyMentioned ? '#c9922a' : '#5e7494'};white-space:nowrap;vertical-align:top">Q${qi+1}</td>
      <td style="padding:8px 12px;font-size:11px;color:#8fa3b8;line-height:1.5;vertical-align:top;max-width:360px">${escHtml(q)}${detailsBlock}</td>
      ${orgCells}
    </tr>`;
  }).join('');

  const orgHeaderCells = orgs.map((org, oi) => {
    const col = orgColorList[oi % orgColorList.length];
    return `<th style="padding:10px 12px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${col};border-left:1px solid #252d40;white-space:nowrap">${escHtml(org)}</th>`;
  }).join('');

  const qMatrix = `<div style="border:1px solid #252d40;border-radius:8px;overflow:hidden;margin-bottom:12px"><div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr style="background:#181e2e">
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5e7494;white-space:nowrap">Q#</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5e7494">Question sent to LLMs</th>
        ${orgHeaderCells}
      </tr>
    </thead>
    <tbody>${qMatrixRows}</tbody>
  </table>
</div></div>`;

  return `
<section style="margin-bottom:56px;scroll-margin-top:24px" id="aeo">
  <div style="margin-bottom:24px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#5e7494;margin-bottom:6px">Section 07 — LLM Visibility</div>
    <h2 style="font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:#d8e4f0;line-height:1.2">LLM Visibility</h2>
    <div style="margin-top:8px;font-size:13px;color:#8fa3b8;max-width:680px;line-height:1.65">When someone asks an AI model about Indian air quality, which organisations does it cite? ${queriesUsed.length} questions sent to ${allLlms.length} LLMs. Each time an org is named in a response, it counts as one mention. ✓ = cited · ✗ = not cited.</div>
    <div style="width:40px;height:2px;background:#c9922a;margin:14px 0 0"></div>
  </div>
  ${summaryTable}
  <details style="border:1px solid #252d40;border-radius:8px;overflow:hidden;margin-bottom:12px">
    <summary style="padding:10px 16px;cursor:pointer;background:#181e2e;display:flex;align-items:center;justify-content:space-between;list-style:none;user-select:none">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a">Question × Organisation Matrix</span>
      <span style="font-family:monospace;font-size:10px;color:#5e7494">▾ expand</span>
    </summary>
    <div style="padding:12px 0 4px">${qMatrix}</div>
  </details>
  <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#5e7494">${allLlms.join(' · ')} · ${queriesUsed.length} questions</div>
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
