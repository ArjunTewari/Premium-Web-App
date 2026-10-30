// Run: node tests/exec-facts.test.cjs. No network, no Claude.
// Findings built from the data (exec-facts.js) are true BY CONSTRUCTION: over many random datasets every number in them is the
// computed value, the checker (sentinel.validateExecSummary) finds nothing to object to, and replacing findings keeps the
// report's three sections. This is the guarantee behind "the summary can no longer stop a report".
const path = require("path");
const dir = path.join(__dirname, "..", "src", "pipeline");
const Facts = require(path.join(dir, "exec-facts.js")), Sentinel = require(path.join(dir, "sentinel.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

// small deterministic random generator
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const NAMES = ["Air Pollution Action Group", "Airveda", "Aurassure", "Centre for Science and Environment", "Chintan Environmental Research and Action Group", "Climate Trends", "Council on Energy, Environment and Water", "CREA", "CSTEP", "EnviroCatalysts", "EPIC India", "Health Effects Institute", "ICCT", "IIT Delhi", "IIT Kanpur", "RaahGiri", "SRIHER", "Sustainable Futures Collaborative", "TERI", "Vital Strategies", "WRI India"];

let datasets = 0, sentencesChecked = 0, bad = [];
for (let n = 0; n < 400; n++) {
  const K = 1 + Math.floor(rnd() * NAMES.length);
  const ORGS = NAMES.slice().sort(() => rnd() - 0.5).slice(0, K);
  const data = {};
  const sparse = rnd() < 0.4; // many datasets are mostly zeros, like the real ones
  for (const o of ORGS) data[o] = {
    total: sparse && rnd() < 0.7 ? 0 : Math.floor(rnd() * 12), dataPct: Math.floor(rnd() * 101), authPct: Math.floor(rnd() * 101),
    aeo: sparse && rnd() < 0.7 ? 0 : Math.floor(rnd() * 101), social: sparse && rnd() < 0.7 ? 0 : Math.floor(rnd() * 11),
  };
  const notCollected = ORGS.filter(() => rnd() < 0.2);
  const F = Facts.build(data, ORGS, { notCollected });
  const execF = [F.press, F.aeo, F.social];
  const v = Sentinel.validateExecSummary(execF, data, ORGS);
  datasets++; sentencesChecked += v.checked;
  if (v.issues.length) bad.push({ ORGS, data, issues: v.issues.slice(0, 2), execF });
  // the figures in the text are exactly the data
  const withArts = ORGS.filter((o) => data[o].total > 0).length;
  if (!new RegExp(`^${withArts} of ${K} organisations recorded articles|^No organisation recorded an article`).test(F.press.headline)) bad.push({ headline: F.press.headline, withArts, K });
  const zeroSoc = ORGS.filter((o) => !(data[o].social > 0)).length;
  if (!new RegExp(`${zeroSoc} ${zeroSoc === 1 ? "organisation" : "organisations"} recorded 0/10`).test(F.social.detail) && zeroSoc > 0 && zeroSoc < K) bad.push({ detail: F.social.detail, zeroSoc });
  if (F.press.headline.split(/\s+/).length > 12 || F.aeo.headline.split(/\s+/).length > 12 || F.social.headline.split(/\s+/).length > 12) bad.push({ longHeadline: [F.press.headline, F.aeo.headline, F.social.headline] });
}
eq(`${datasets} random datasets: findings built from the data verify clean (${sentencesChecked} numeric claims checked), figures are the data's, headlines ≤ 12 words`, bad.length, 0);
if (bad.length) console.log(JSON.stringify(bad[0], null, 1).slice(0, 1500));

// replacing keeps the sections
const ORGS = ["CREA", "TERI"]; const data = { CREA: { total: 2, aeo: 0, social: 9, dataPct: 100, authPct: 0 }, TERI: { total: 1, aeo: 31, social: 0, dataPct: 100, authPct: 0 } };
const f = (headline, section_ref) => ({ headline, detail: "x", section_ref });
let r = Facts.replace([f("a", "§03 AQ Press Analytics"), f("b", "§AEO LLM Visibility"), f("c", "§Social Media")], [1], data, ORGS, {});
eq("a bad AEO finding is replaced by the AEO finding built from the data; the others stay", [r.execF.map((x) => x.headline), r.replaced.length, r.dropped.length], [["a", "1 of 2 organisations scored above zero on AI-assistant visibility", "c"], 1, 0]);
r = Facts.replace([f("a", "§03 AQ Press Analytics"), f("b", "§03 AQ Press Analytics")], [0], data, ORGS, {});
eq("two findings on one section: the replacement takes a section that is not covered", r.execF.map((x) => x.section_ref), ["§03 AQ Press Analytics", "§AEO LLM Visibility"]);
r = Facts.replace([], [], data, ORGS, {});
eq("nothing written: all three, in section order", r.execF.map((x) => x.section_ref), ["§03 AQ Press Analytics", "§AEO LLM Visibility", "§Social Media"]);
r = Facts.replace([f("a", "§03 AQ Press Analytics"), f("b", "§AEO LLM Visibility"), f("c", "§Social Media"), f("d", "§05 Topic Ownership")], [3], data, ORGS, {});
eq("a bad finding with every section already covered is dropped, not duplicated", [r.execF.length, r.dropped.length], [3, 1]);
eq("organisations not collected are named, as counted 0, in the social finding", /Not collected on at least one platform, and counted as 0 there: CREA and TERI\./.test(Facts.build(data, ORGS, { notCollected: ["CREA", "TERI"] }).social.detail), true);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
