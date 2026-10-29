'use strict';
/**
 * exec-facts.js — executive-summary findings built straight from the computed data.
 *
 * Why: the model's wording is checked against the data (sentinel.validateExecSummary), and text that fails that check must
 * never be "repaired" by editing numbers into the sentence — deciding which organisation a number belongs to is a guess,
 * and a wrong guess turns a true sentence into a false one (26-28 Oct: "ranged from 51 to 51", "collectively published
 * 1 articles", "scored 33/100 and 33/100"). A finding that cannot be verified is instead REPLACED by one of these:
 * every number in them is read from the data, never from a model, so they are true by construction. Sentences name one
 * organisation (or a group with "each"), which is exactly what the checker can verify.
 */

const SECTIONS = { press: '§03 AQ Press Analytics', aeo: '§AEO LLM Visibility', social: '§Social Media' };
const MAX_GROUPS = 4;

const plural = (n, one, many) => (n === 1 ? one : many);

// Organisations grouped by value, highest first; ties keep the order of ORGS.
function groups(ORGS, data, field) {
  const byValue = new Map();
  for (const o of ORGS) {
    const v = data[o] && data[o][field];
    if (typeof v !== 'number' || !(v > 0)) continue;
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(o);
  }
  return [...byValue.entries()].sort((a, b) => b[0] - a[0]);
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// "A recorded 2 articles." / "A and B each recorded 2 articles." — `fmt(v)` gives the figure with its unit.
function sentences(grps, verb, fmt) {
  const shown = grps.slice(0, MAX_GROUPS);
  const out = shown.map(([v, names]) => (names.length === 1 ? `${names[0]} ${verb} ${fmt(v)}.` : `${listNames(names)} each ${verb} ${fmt(v)}.`));
  return { out, rest: grps.slice(MAX_GROUPS).reduce((n, [, names]) => n + names.length, 0) };
}

function build(data, ORGS, opts = {}) {
  const K = ORGS.length;
  const notCollected = (opts.notCollected || []).filter((o) => ORGS.includes(o));
  const res = {};

  // press
  {
    const g = groups(ORGS, data, 'total');
    const withArts = g.reduce((n, [, names]) => n + names.length, 0);
    const zero = K - withArts;
    if (!withArts) {
      res.press = { headline: 'No organisation recorded an article in the period', detail: `${K} ${plural(K, 'organisation', 'organisations')} recorded 0 articles in the period.`, section_ref: SECTIONS.press };
    } else {
      const { out, rest } = sentences(g, 'recorded', (v) => `${v} ${plural(v, 'article', 'articles')}`);
      if (rest) out.push(`${rest} further ${plural(rest, 'organisation', 'organisations')} also recorded articles.`);
      out.push(`${zero} ${plural(zero, 'organisation', 'organisations')} recorded 0 articles.`);
      res.press = { headline: `${withArts} of ${K} organisations recorded articles in the period`, detail: out.join(' '), section_ref: SECTIONS.press };
    }
  }

  // AI-assistant visibility
  {
    const g = groups(ORGS, data, 'aeo');
    const withAeo = g.reduce((n, [, names]) => n + names.length, 0);
    const zero = K - withAeo;
    if (!withAeo) {
      res.aeo = { headline: 'No organisation scored above zero on AI-assistant visibility', detail: `${K} ${plural(K, 'organisation', 'organisations')} scored 0/100 on AI-assistant visibility.`, section_ref: SECTIONS.aeo };
    } else {
      const { out, rest } = sentences(g, 'scored', (v) => `${v}/100`);
      if (rest) out.push(`${rest} further ${plural(rest, 'organisation', 'organisations')} also scored above 0/100.`);
      out.push(`${zero} ${plural(zero, 'organisation', 'organisations')} scored 0/100.`);
      res.aeo = { headline: `${withAeo} of ${K} organisations scored above zero on AI-assistant visibility`, detail: out.join(' '), section_ref: SECTIONS.aeo };
    }
  }

  // social presence
  {
    const g = groups(ORGS, data, 'social');
    const withSocial = g.reduce((n, [, names]) => n + names.length, 0);
    const zero = K - withSocial;
    const note = notCollected.length ? ` Not collected on at least one platform, and counted as 0 there: ${listNames(notCollected)}.` : '';
    if (!withSocial) {
      res.social = { headline: 'No organisation recorded social presence in the period', detail: `${K} ${plural(K, 'organisation', 'organisations')} recorded 0/10 social presence.${note}`, section_ref: SECTIONS.social };
    } else {
      const { out, rest } = sentences(g, 'recorded', (v) => `${v}/10 social presence`);
      if (rest) out.push(`${rest} further ${plural(rest, 'organisation', 'organisations')} also recorded a score above 0/10.`);
      out.push(`${zero} ${plural(zero, 'organisation', 'organisations')} recorded 0/10.`);
      res.social = { headline: `${withSocial} of ${K} organisations recorded social presence`, detail: out.join(' ') + note, section_ref: SECTIONS.social };
    }
  }
  return res;
}

const BY_SECTION = { [SECTIONS.press]: 'press', [SECTIONS.aeo]: 'aeo', [SECTIONS.social]: 'social' };

/**
 * Replace the findings at `badIdx` with data-built ones. A bad finding gets the data-built finding of ITS section when that
 * section is not already covered by a finding that stays; otherwise any section not yet covered; otherwise it is dropped.
 * `execF` empty → all three. Returns { execF, replaced: [{headline, with}], dropped: [{headline}] }.
 */
function replace(execF, badIdx, data, ORGS, opts = {}) {
  const facts = build(data, ORGS, opts);
  const bad = new Set(badIdx);
  const keep = execF.filter((_, i) => !bad.has(i));
  const used = new Set(keep.map((f) => BY_SECTION[f.section_ref]).filter(Boolean));
  const out = [...keep];
  const replaced = [], dropped = [];
  const place = (headline, key) => { out.push(facts[key]); used.add(key); replaced.push({ headline, with: facts[key].headline }); };
  if (!execF.length) { for (const key of ['press', 'aeo', 'social']) place('(none written)', key); return { execF: out, replaced, dropped }; }
  for (const i of [...bad].sort((a, b) => a - b)) {
    const f = execF[i] || {};
    const own = BY_SECTION[f.section_ref];
    const key = own && !used.has(own) ? own : ['press', 'aeo', 'social'].find((k) => !used.has(k));
    if (key) place(f.headline || '', key); else dropped.push({ headline: f.headline || '' });
  }
  // keep the report's section order stable: press, AEO, social, then anything else
  const rank = (f) => { const k = BY_SECTION[f.section_ref]; return k ? ['press', 'aeo', 'social'].indexOf(k) : 9; };
  out.sort((a, b) => rank(a) - rank(b));
  return { execF: out, replaced, dropped };
}

module.exports = { build, replace, SECTIONS };
