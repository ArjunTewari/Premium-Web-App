"use strict";
/**
 * frameworks/ — the subject-matter definition of a report.
 *
 * The pipeline (outlets, collectors, scoring, report layout) is subject-neutral;
 * what makes a report an *air quality* report is a set of words and questions:
 * the topic taxonomy and its keyword gate, the Exa search queries, the social
 * search terms, the AI-search questions, and the wording of the Claude prompts
 * and report headings. A framework bundles all of that. "air-quality" is the
 * original and is unchanged; "climate" and "sustainability" replicate it for
 * those subjects.
 *
 * Usage: a run calls setActiveFramework(cfg.FRAMEWORK) once at its start. Modules
 * that keep module-level lists register with onFrameworkChange() and have the list
 * swapped in place, so references held elsewhere stay valid. (A run is already
 * single-flight in this process — the usage counters are shared the same way.)
 */

const REGISTRY = {
  "air-quality": require("./air-quality"),
  climate: require("./climate"),
  sustainability: require("./sustainability"),
};
const DEFAULT_ID = "air-quality";

let active = REGISTRY[DEFAULT_ID];
const listeners = [];

function getFramework(id) {
  const fw = REGISTRY[id || DEFAULT_ID];
  if (!fw) throw new Error(`Unknown framework "${id}". Available: ${Object.keys(REGISTRY).join(", ")}`);
  return fw;
}
function getActiveFramework() { return active; }

/** Run fn now with the active framework, and again each time it changes. */
function onFrameworkChange(fn) { listeners.push(fn); fn(active); }

function setActiveFramework(id) {
  active = getFramework(id);
  for (const fn of listeners) fn(active);
  return active;
}

/** Replace the contents of an array in place (keeps every reference valid). */
function replaceInPlace(arr, next) { arr.length = 0; arr.push(...next); return arr; }

/**
 * Re-word report/prompt text for the active framework. Air quality maps to
 * itself, so its output is untouched; for others, "AQ" / "air quality" become
 * the framework's own subject word.
 */
function fwText(str, fw = active) {
  const terms = fw.terms;
  if (!terms || typeof str !== "string") return str;
  let s = str;
  if (terms["Air Quality"]) s = s.replace(/Air Quality/g, terms["Air Quality"]);
  if (terms["air quality"]) s = s.replace(/air quality/g, terms["air quality"]);
  if (terms.AQ) s = s.replace(/\bAQ\b/g, terms.AQ);
  return s;
}

// ── keyword matching ────────────────────────────────────────────────────────
// "substring" (air quality): a term matches anywhere in the text — the original
//   behaviour, kept exactly.
// "word": a term must start and end on a word boundary, a trailing plural is
//   allowed, and a term written "re:<pattern>" is a regular expression. This is
//   what stops "coal" matching "coalition", "ghg" matching inside a longer token,
//   or a COP summit number needing its own entry.
const _re = new Map();
function termRegex(term) {
  let r = _re.get(term);
  if (!r) {
    if (term.startsWith("re:")) r = new RegExp(term.slice(3), "i");
    else {
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      r = new RegExp("(?<![a-z0-9])" + esc + "(?:s|es)?(?![a-z0-9])", "i");
    }
    _re.set(term, r);
  }
  return r;
}
function termMatches(text, term, fw = active) {
  const t = String(text || "").toLowerCase();
  if (fw.matchMode === "word") return termRegex(term.toLowerCase()).test(t);
  return t.includes(term.toLowerCase());
}
function matchedTerms(text, terms, fw = active) {
  return terms.filter((k) => termMatches(text, k, fw));
}

// ── validation (run at load and in tests) ───────────────────────────────────
const SHORT_OK = new Set(["co2", "ghg", "sdg", "esg", "ndc", "ncap", "aqi", "pm10", "grap", "slcp", "ipcc"]);
function validateFramework(fw) {
  const p = [];
  const need = (k) => { if (fw[k] === undefined || fw[k] === null || fw[k] === "") p.push(`missing ${k}`); };
  ["id", "name", "short", "title", "eyebrow", "platform", "subject", "sector", "relevanceRule", "evidencePhrase", "specificity", "catchAll", "matchMode"].forEach(need);
  if (!["substring", "word"].includes(fw.matchMode)) p.push(`matchMode must be substring or word`);
  const keys = (fw.topics || []).map((t) => t.key);
  if (!keys.length) p.push("no topics");
  if (new Set(keys).size !== keys.length) p.push("duplicate topic keys");
  if (new Set((fw.topics || []).map((t) => t.label)).size !== keys.length) p.push("duplicate topic labels");
  if (keys.length && !keys.includes(fw.catchAll)) p.push(`catchAll "${fw.catchAll}" is not a topic key`);
  for (const t of fw.topics || []) if (!t.key || !t.label || !t.subtitle) p.push(`topic ${JSON.stringify(t.key)} needs key, label, subtitle`);
  for (const [name, list, min] of [
    ["gateKeywords", fw.gateKeywords, 10], ["socialSearchKeywords", fw.socialSearchKeywords, 5], ["postFilterTerms", fw.postFilterTerms, 5],
    ["youtubeTerms", fw.youtubeTerms, 5], ["exaClusters", fw.exaClusters, 2], ["aeoQuestions", fw.aeoQuestions, 10],
    ["aeoQuestionsReport", fw.aeoQuestionsReport, 10], ["aeoQuestionsDiscovery", fw.aeoQuestionsDiscovery, 10], ["defaultScope", fw.defaultScope, 5],
  ]) {
    if (!Array.isArray(list) || list.length < min) { p.push(`${name} needs at least ${min} entries`); continue; }
    if (new Set(list.map((x) => String(x).toLowerCase())).size !== list.length) p.push(`${name} has duplicates`);
    if (list.some((x) => typeof x !== "string" || !x.trim())) p.push(`${name} has an empty entry`);
  }
  if (fw.matchMode === "substring" && fw.id !== "air-quality") p.push("only air-quality may use substring matching");
  // very short bare words match inside other words under substring matching
  if (fw.matchMode === "substring") {
    for (const k of [...(fw.postFilterTerms || []), ...(fw.youtubeTerms || [])]) if (!k.includes(" ") && k.length <= 3 && !SHORT_OK.has(k.toLowerCase())) p.push(`risky short term "${k}"`);
  }
  for (const k of fw.gateKeywords || []) if (k.startsWith("re:")) { try { new RegExp(k.slice(3)); } catch { p.push(`bad regex ${k}`); } }
  return p;
}

for (const fw of Object.values(REGISTRY)) {
  const problems = validateFramework(fw);
  if (problems.length) throw new Error(`Framework "${fw.id}" is invalid: ${problems.join("; ")}`);
}

/** What the web app needs to offer a framework and fill its defaults. */
function listFrameworks() {
  return Object.values(REGISTRY).map((fw) => ({
    id: fw.id, name: fw.name, short: fw.short,
    topics: fw.topics.map((t) => ({ key: t.key, label: t.label })),
    defaultScope: fw.defaultScope, aeoQuestions: fw.aeoQuestions,
  }));
}

module.exports = {
  DEFAULT_ID, getFramework, getActiveFramework, setActiveFramework, onFrameworkChange,
  replaceInPlace, fwText, termMatches, matchedTerms, validateFramework, listFrameworks,
  frameworkIds: () => Object.keys(REGISTRY),
};
