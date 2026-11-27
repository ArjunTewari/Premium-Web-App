"use strict";
/**
 * interactive-report.js — one page of the Interactive section as a stand-alone report, for sending or keeping.
 *
 *   renderInteractiveReport(dataset, { topic, orgs, generatedAt }) → an HTML string
 *
 * `dataset` is a week's (or any period's) posts file (see post-scopes.js). `topic` is "full" (every scope, including Other) or one
 * of air-quality / climate / sustainability; `orgs` limits the page to those organisations (none = all of them).
 * Each organisation gets a pie: in the full report by scope, in a topic report by platform. Everything is drawn in the page
 * itself (SVG, no script), so the file opens anywhere. Nothing here reads or uses the AI-assistant (AEO) measurement.
 */

const { injectReportTag } = require("./report-tag");

const COLOUR = { "air-quality": "#3d8ef0", climate: "#e8743b", sustainability: "#34a56f", other: "#8b93a1", li: "#0a66c2", x: "#4b5563", ig: "#c13584" };
const PLATFORM = { li: "LinkedIn", x: "X", ig: "Instagram" };
const TOPICS = { full: "Full report", "air-quality": "Air quality", climate: "Climate", sustainability: "Sustainability" };

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "0%");

/** An SVG pie of [{label, value, colour}]; a single slice is a full circle, no slices an empty ring. */
function pie(slices, size = 120) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 2, c = size / 2;
  if (!total) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="no posts"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="2"/></svg>`;
  const live = slices.filter((s) => s.value > 0);
  if (live.length === 1) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img"><title>${esc(live[0].label)}: ${live[0].value}</title><circle cx="${c}" cy="${c}" r="${r}" fill="${live[0].colour}"/></svg>`;
  let a0 = -Math.PI / 2;
  const paths = live.map((s) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0), x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
    const d = `M${c},${c} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${s.colour}" stroke="var(--card)" stroke-width="1.5"><title>${esc(s.label)}: ${s.value} (${pct(s.value, total)})</title></path>`;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${paths.join("")}</svg>`;
}

function renderInteractiveReport(ds, opts = {}) {
  const topic = TOPICS[opts.topic] ? opts.topic : "full";
  const scopes = ds.scopes.map((s) => s.id);
  const labelOf = (id) => (ds.scopes.find((s) => s.id === id) || { label: id }).label;
  const shown = topic === "full" ? scopes : [topic];
  const chosen = Array.isArray(opts.orgs) ? opts.orgs.filter((o) => ds.orgs.includes(o)) : [];
  const orgs = chosen.length ? ds.orgs.filter((o) => chosen.includes(o)) : ds.orgs;

  const posts = ds.posts.filter((p) => p.s && shown.includes(p.s));
  const counts = (org, key) => { const m = {}; for (const p of posts) if (!org || p.o === org) m[p[key]] = (m[p[key]] || 0) + 1; return m; };
  const perOrg = ds.orgs.map((o) => ({ org: o, total: posts.filter((p) => p.o === o).length, byScope: counts(o, "s"), byPlatform: counts(o, "p") }));
  const field = perOrg; // the median and total are taken over EVERY organisation, whichever are picked for the page
  const cols = topic === "full" ? [...scopes, "all"] : [topic, "all"];
  const colVal = (r, c) => (c === "all" ? r.total : r.byScope[c] || 0);
  const colLabel = (c) => (c === "all" ? (topic === "full" ? "All posts" : `All ${labelOf(topic)} posts`) : labelOf(c));
  const totals = Object.fromEntries(cols.map((c) => [c, field.reduce((a, r) => a + colVal(r, c), 0)]));
  const medians = Object.fromEntries(cols.map((c) => [c, median(field.map((r) => colVal(r, c)))]));

  const title = `${TOPICS[topic]}${chosen.length ? ` · ${orgs.join(", ")}` : ""}`;
  const generated = opts.generatedAt || new Date().toISOString().slice(0, 10);

  const tiles = (topic === "full" ? scopes : [topic]).map((s) => {
    const n = posts.filter((p) => p.s === s).length;
    return `<div class="tile" style="border-top:3px solid ${COLOUR[s]}"><div class="tl">${esc(labelOf(s))}</div><div class="tn">${n}</div><div class="ts">${pct(n, posts.length)} of ${topic === "full" ? "all posts" : "this topic"}</div></div>`;
  }).join("");

  const pies = orgs.map((o) => {
    const r = perOrg.find((x) => x.org === o);
    const slices = topic === "full"
      ? scopes.map((s) => ({ label: labelOf(s), value: r.byScope[s] || 0, colour: COLOUR[s] }))
      : Object.keys(PLATFORM).map((p) => ({ label: PLATFORM[p], value: r.byPlatform[p] || 0, colour: COLOUR[p] }));
    const legend = slices.filter((s) => s.value > 0).map((s) => `<li><span class="dot" style="background:${s.colour}"></span>${esc(s.label)} <b>${s.value}</b> <span class="mut">${pct(s.value, r.total)}</span></li>`).join("") || '<li class="mut">no posts</li>';
    return `<div class="pie"><div class="pn">${esc(o)}</div>${pie(slices)}<div class="pt">${r.total} post${r.total === 1 ? "" : "s"}</div><ul>${legend}</ul></div>`;
  }).join("");

  const bench = `<table class="bt"><thead><tr><th></th>${cols.map((c) => `<th style="color:${COLOUR[c] || "inherit"}">${esc(colLabel(c))}</th>`).join("")}</tr></thead><tbody>
<tr><td><b>Total (all ${ds.orgs.length} organisations)</b></td>${cols.map((c) => `<td class="c">${totals[c]}</td>`).join("")}</tr>
<tr><td><b>Median organisation</b></td>${cols.map((c) => `<td class="c">${num(medians[c])}</td>`).join("")}</tr>
${chosen.length ? orgs.map((o) => { const r = perOrg.find((x) => x.org === o); return `<tr class="me"><td><b>${esc(o)}</b></td>${cols.map((c) => { const v = colVal(r, c), m = medians[c]; return `<td class="c">${v} <span class="mut">${v > m ? "▲" : v < m ? "▼" : "="}</span></td>`; }).join("")}</tr>`; }).join("") : ""}
</tbody></table>${chosen.length ? '<p class="mut">▲ above, ▼ below, = equal to the median organisation.</p>' : ""}`;

  const top = posts.filter((p) => orgs.includes(p.o)).sort((a, b) => b.l + b.c + b.h - (a.l + a.c + a.h) || b.d.localeCompare(a.d)).slice(0, 20);
  const topHtml = top.length ? top.map((p) => `<div class="post" style="border-left:3px solid ${COLOUR[p.s] || COLOUR.other}"><div class="pm"><b>${esc(p.o)}</b> · ${esc(PLATFORM[p.p] || p.p)} · <span style="color:${COLOUR[p.s]};font-weight:700">${esc(labelOf(p.s))}</span> · ${esc(String(p.d).slice(0, 10))} · ♥ ${p.l} · 💬 ${p.c} · ↗ ${p.h}${p.v ? ` · 👁 ${p.v}` : ""}${p.u ? ` · <a href="${esc(p.u)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</div><div class="pb">${esc(p.t.length > 260 ? `${p.t.slice(0, 260)}…` : p.t || "(no text)")}</div></div>`).join("") : '<p class="mut">No posts match.</p>';

  const css = `:root{--bg:#f5f7fb;--card:#fff;--ink:#1a2232;--mut:#5a6a80;--line:#dde3ef;--amber:#c9922a}
@media(prefers-color-scheme:dark){:root{--bg:#0f1923;--card:#16222f;--ink:#e8edf5;--mut:#9aa9bd;--line:#2a3a4d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.5}
main{max-width:1100px;margin:0 auto;padding:28px 18px 60px}
.ey{font:700 13px 'DM Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--amber)}h1{font-size:30px;margin:6px 0 4px}h2{font-size:20px;margin:30px 0 8px}
.rm{color:var(--mut)}.mut{color:var(--mut)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:14px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tl{font:600 12px 'DM Mono',monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}.tn{font-size:30px;font-weight:700}.ts{font-size:12.5px;color:var(--mut)}
.pies{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}.pie{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center}
.pn{font-weight:700;margin-bottom:6px;min-height:42px}.pt{font:600 13px 'DM Mono',monospace;margin:4px 0}.pie ul{list-style:none;margin:6px 0 0;padding:0;text-align:left;font-size:13px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.bt{width:100%;border-collapse:separate;border-spacing:3px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px}.bt th{font-weight:700;padding:4px 8px}.bt td{padding:6px 8px}.c{text-align:center;font-family:'DM Mono',monospace;font-weight:700;background:rgba(128,128,128,.12);border-radius:6px}.me td{outline:1px solid var(--amber)}
.post{background:var(--card);border:1px solid var(--line);border-radius:0 8px 8px 0;padding:8px 12px;margin-bottom:8px}.pm{font:12.5px 'DM Mono',monospace;color:var(--mut)}.pm a{color:var(--amber)}.pb{margin-top:4px}
footer{margin-top:34px;color:var(--mut);font-size:13px}`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="emerald-interactive" content="${esc(topic)}">
<title>${esc(title)} — ${esc(ds.dateFrom)} to ${esc(ds.dateTo)}</title><style>${css}</style></head><body><main id="top">
<div class="ey">All Scope · ${esc(TOPICS[topic])}</div><h1>${esc(title)}</h1>
<div class="rm">Period: ${esc(ds.dateFrom)} &rarr; ${esc(ds.dateTo)} &middot; ${ds.posts.length} posts from ${ds.orgs.length} organisations &middot; generated ${esc(generated)}</div>
<p class="mut">Each post is put in the one scope it is mainly about: air quality, climate, sustainability, or other.${topic === "full" ? "" : ` This report shows only the ${esc(labelOf(topic))} posts.`}</p>
<h2>Scope summary</h2><div class="tiles">${tiles}</div>
<h2>${topic === "full" ? "Each organisation's posts by scope" : `Each organisation's ${esc(labelOf(topic))} posts by platform`}</h2><div class="pies">${pies}</div>
<h2>Benchmark table</h2>${bench}
<h2>Posts <span class="mut" style="font-size:14px;font-weight:400">(most engagement first, up to 20)</span></h2>${topHtml}
<footer>Emerald AI · Triple Media Pulse · publicly available data</footer></main></body></html>`;
  return injectReportTag(html, { kind: opts.topic && opts.topic !== "full" ? `${TOPICS[topic]} report` : "Full report", from: ds.dateFrom, to: ds.dateTo });
}

module.exports = { renderInteractiveReport, pie, TOPICS };
