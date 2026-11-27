"use strict";
/**
 * report-tag.js — the label in the top-right corner of every report: what the report is and the period it covers.
 * Clicking it takes the reader back to the top of the page.
 *
 *   injectReportTag(html)  → the same page with the tag added; a page that already has it is returned unchanged
 *
 * It is used when a report is built, and again when a stored report is opened, downloaded or emailed, so reports built before
 * this existed carry it too. The period is read from the report itself (the "Period …" line every report has).
 */

const MARK = 'data-emerald-tag="1"';
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "2 Nov – 8 Nov 2026"; both years when the period crosses a year. */
function formatPeriod(from, to) {
  const a = /^(\d{4})-(\d\d)-(\d\d)$/.exec(from), b = /^(\d{4})-(\d\d)-(\d\d)$/.exec(to);
  if (!a || !b) return "";
  const d = (m) => `${Number(m[3])} ${MON[Number(m[2]) - 1]}`;
  return a[1] === b[1] ? `${d(a)} – ${d(b)} ${b[1]}` : `${d(a)} ${a[1]} – ${d(b)} ${b[1]}`;
}

/** The period a report states: "Period: 2026-11-02 → 2026-11-08", "Period 2026-10-05 to 2026-11-01", or null. */
function periodOf(html) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&rarr;|&mdash;|&middot;/g, " ");
  const m = /Period:?\s*(\d{4}-\d\d-\d\d)\s*(?:→|to|-)?\s*(\d{4}-\d\d-\d\d)/.exec(text) || /(\d{4}-\d\d-\d\d)\s*(?:→|to)\s*(\d{4}-\d\d-\d\d)/.exec(text);
  return m ? { from: m[1], to: m[2] } : null;
}

/** What kind of report this is, for the label. */
function kindOf(html) {
  const head = String(html).slice(0, 6000);
  const t = /<meta name="emerald-report-type" content="(benchmark|snapshot)">/i.exec(head);
  if (t) return /^b/i.test(t[1]) ? "Benchmark" : "Snapshot";
  if (/<meta name="emerald-interactive"/i.test(head)) return "Interactive report";
  return "Full report";
}

const CSS = `.etag{font-family:'DM Mono',ui-monospace,monospace;font-size:13px;font-weight:600;letter-spacing:.03em;color:var(--text,#1a2232);background:var(--surface,#fff);border:1px solid var(--border2,#c9d2e3);border-radius:20px;padding:7px 14px;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.etag:hover{border-color:var(--amber,#c9922a);color:var(--amber,#c9922a)}
.etag .etag-p{font-weight:400;opacity:.85}
.etag-fixed{position:fixed;top:12px;right:16px;z-index:2100}
.edit-bar .etag{position:static}
@media(min-width:701px){.banner{padding-right:300px!important}}
@media(max-width:700px){.etag{font-size:11.5px;padding:5px 10px}.etag-fixed{top:8px;right:8px}}
@media print{.etag{display:none!important}}`;

const JS = `function emeraldTop(e){if(e&&e.preventDefault)e.preventDefault();try{window.scrollTo({top:0,behavior:'smooth'});}catch(x){window.scrollTo(0,0);}var s=document.scrollingElement;if(s)s.scrollTop=0;var m=document.querySelector('main');if(m)m.scrollTop=0;}`;

function injectReportTag(html, opts = {}) {
  html = String(html);
  if (html.includes(MARK)) return html;
  const kind = opts.kind || kindOf(html);
  const p = opts.from && opts.to ? { from: opts.from, to: opts.to } : periodOf(html);
  const period = p ? formatPeriod(p.from, p.to) : "";
  const inner = `${esc(kind)}${period ? ` <span class="etag-p">· ${esc(period)}</span>` : ""}`;
  const label = `${kind}${period ? `, ${period}` : ""}. Click to go to the top`;
  const mk = (extra) => `<a href="#" class="etag${extra}" ${MARK} title="${esc(label)}" onclick="emeraldTop(event)">${inner}</a>`;

  let out = html;
  // style + script just before </head> / </body> (a page without them gets them at the ends)
  const styleTag = `<style data-emerald-tag-css>${CSS}</style>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${styleTag}</head>`) : styleTag + out;
  const scriptTag = `<script>${JS}</script>`;
  // Where the tag goes: the top-right bar the full report already has, otherwise fixed in the corner.
  const bar = /(<div class="edit-bar"[^>]*>)/i;
  if (bar.test(out)) out = out.replace(bar, `$1${mk("")}`);
  else if (/<body[^>]*>/i.test(out)) out = out.replace(/(<body[^>]*>)/i, `$1${mk(" etag-fixed")}`);
  else out = mk(" etag-fixed") + out;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${scriptTag}</body>`) : out + scriptTag;
  return out;
}

module.exports = { injectReportTag, periodOf, formatPeriod, kindOf, MARK };
