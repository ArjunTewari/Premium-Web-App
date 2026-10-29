// Run: node tests/exec-claims.test.cjs  (needs the app's node_modules). No network, no Claude.
// A number in the executive summary that disagrees with the computed data is corrected when the
// field is unambiguous, and the finding is removed (and logged) when it still cannot be verified.
const Module = require("module"); const path = require("path");
const dir = path.join(__dirname, "..", "src", "pipeline");
const Sentinel = require(path.join(dir, "sentinel.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const ORGS = ["CREA", "TERI"];
const data = { CREA: { total: 2, dataPct: 100, authPct: 0, aeo: 0, social: 9 }, TERI: { total: 1, dataPct: 100, authPct: 0, aeo: 31, social: 6 } };
const f = (headline, detail) => ({ headline, detail });

// "%" with a word that says which share it is
let v = Sentinel.validateExecSummary([f("CREA leads on substance", "CREA: 50% data-specific content across its articles.")], data, ORGS);
eq("'50% data-specific' against dataPct=100 is an issue about dataPct only", [v.issues.length, v.issues[0] && v.issues[0].actual, v.issues[0] && v.issues[0].correctedValue], [1, "dataPct=100", "100"]);
const fixed = Sentinel.applyCorrections([f("CREA leads on substance", "CREA: 50% data-specific content across its articles.")], v.issues);
eq("it is corrected in the text", fixed[0].detail, "CREA: 100% data-specific content across its articles.");

v = Sentinel.validateExecSummary([f("x", "TERI: 100% data-specific coverage.")], data, ORGS);
eq("a correct '% data-specific' passes", v.issues.length, 0);
v = Sentinel.validateExecSummary([f("x", "TERI: 0% authoritative coverage.")], data, ORGS);
eq("a correct '% authoritative' passes", v.issues.length, 0);
// 26 Oct: a headline that ends in a figure for a GROUP, with no organisation named in the headline, was pinned on the
// first organisation of the detail and "corrected" to that organisation's figure ("9 organisations recorded 10/10").
const grp = [f("Social presence: CREA 9/10; 9 organisations recorded 0/10", "CREA recorded 9/10 social presence. 9 organisations recorded 0/10.")];
v = Sentinel.validateExecSummary(grp, data, ORGS);
eq("a group figure in a headline is not pinned on an organisation of the detail", [v.issues.length, Sentinel.applyCorrections(grp, v.issues)[0].headline], [0, grp[0].headline]);
const grp2 = [f("Nine organisations recorded 0/10 social presence", "CREA recorded 9/10 social presence.")];
v = Sentinel.validateExecSummary(grp2, data, ORGS);
eq("a headline with no organisation named is left alone, and the detail is still checked", [v.issues.length, Sentinel.applyCorrections(grp2, v.issues)[0].headline], [0, grp2[0].headline]);
v = Sentinel.validateExecSummary([f("Social presence", "CREA recorded 4/10 social presence.")], data, ORGS);
eq("a wrong number in the detail is still caught", [v.issues.length, v.issues[0].correctedValue], [1, "9"]);
// 28 Oct (12-18 Oct run): organisations named TOGETHER are one subject. A correct collective total or "respectively" pair was
// "corrected" into a false number by pinning it on the last organisation of the list; the reviewer then stopped the run.
const ORGS5 = ["Centre for Science and Environment", "CREA", "EnviroCatalysts", "IIT Kanpur", "TERI"];
const data5 = { "Centre for Science and Environment": { total: 2, aeo: 51 }, CREA: { total: 2, aeo: 2 }, EnviroCatalysts: { total: 1, aeo: 0 }, "IIT Kanpur": { total: 1, aeo: 4 }, TERI: { total: 1, aeo: 33 } };
const five = "Centre for Science and Environment, CREA, EnviroCatalysts, IIT Kanpur, and TERI";
const good = [f("Five organisations published articles", `${five} collectively published 7 articles. Centre for Science and Environment and TERI scored 51/100 and 33/100 on AEO metrics respectively.`)];
v = Sentinel.validateExecSummary(good, data5, ORGS5);
eq("a correct collective total and a 'respectively' pair are left exactly as written", [v.issues.length, Sentinel.applyCorrections(good, v.issues)[0].detail === good[0].detail], [0, true]);
const bad = [f("x", `${five} collectively published 5 articles.`)];
v = Sentinel.validateExecSummary(bad, data5, ORGS5);
eq("a wrong collective total is corrected to the SUM of the listed organisations, not to the last one", [v.issues.length, Sentinel.applyCorrections(bad, v.issues)[0].detail.endsWith("collectively published 7 articles.")], [1, true]);
v = Sentinel.validateExecSummary([f("x", "IIT Kanpur recorded 3 articles and EnviroCatalysts 3. TERI scored 40/100 and CREA 2/100.")], data5, ORGS5);
eq("clauses about one organisation are still checked", v.issues.map((i) => [i.org, i.claimed, i.correctedValue]), [["IIT Kanpur", 3, "1"], ["TERI", 40, "33"]]);
v = Sentinel.validateExecSummary([f("x", "CREA: 50% authoritative citations.")], data, ORGS);
eq("'50% authoritative' is checked against authPct", [v.issues.length, v.issues[0].actual, v.issues[0].correctedValue], [1, "authPct=0", "0"]);

// no word to say which share: still checked against both, never corrected on a guess
v = Sentinel.validateExecSummary([f("x", "CREA: 50% overall.")], data, ORGS);
eq("an unlabelled % that matches neither is an issue and is not auto-corrected", [v.issues.length, v.issues[0].correctedValue], [1, null]);
v = Sentinel.validateExecSummary([f("x", "CREA: 100% overall.")], data, ORGS);
eq("an unlabelled % that matches one of the two passes", v.issues.length, 0);

// "5 article-publishing organizations" is a count of organisations, not "5 articles": it must not be
// attributed to an organisation or "corrected" (the 26 Oct run turned it into "0 article-publishing organizations")
v = Sentinel.validateExecSummary([f("Social media", "The 5 article-publishing organizations averaged 5.6/10 social presence (CREA 9/10, TERI 6/10); CREA had 2 articles.")], data, ORGS);
eq("'N article-publishing organizations' is not an article claim", v.issues.map((i) => i.metric + ":" + i.claimed), []);
v = Sentinel.validateExecSummary([f("x", "CREA: 7 article-published pieces and 2 articles.")], data, ORGS);
eq("a real '2 articles' claim is still checked", v.issues.length, 0);
v = Sentinel.validateExecSummary([f("x", "CREA published 7 articles in the period.")], data, ORGS);
eq("a wrong '7 articles' claim is still caught and corrected", [v.issues.length, v.issues[0].correctedValue], [1, "2"]);

// the graph: a model that keeps writing an unverifiable number loses that finding, loudly
const CC = require(path.join(dir, "claude-client.js"));
let calls = 0;
CC.callClaude = async () => { calls++; return "unused"; };
CC.parseJ = () => [f("CREA is ahead", "CREA holds 50% overall."), f("TERI AI visibility", "TERI scores 31/100 on AEO."), f("Press", "CREA has 2 articles.")];
const Graph = require(path.join(dir, "graphs", "exec-summary-graph.js"));
(async () => {
  const msgs = [];
  const r = await Graph.run({ cfg: { CLAUDE_KEY: "x" }, data, ORGS, DATE_FROM: "2026-10-12", DATE_TO: "2026-10-18", orgSummary: "", cb: (m) => msgs.push(m) });
  eq("the model was asked twice (1 + 1 corrective) when something cannot be corrected in code", calls, 2);
  eq("the finding with the unverifiable number is removed; the verified ones stay", r.execF.map((x) => x.headline), ["TERI AI visibility", "Press"]);
  eq("nothing unverified remains and the removal is recorded", [r.execAudit.issues.length, r.execAudit.dropped.length, r.execAudit.dropped[0].headline], [0, 1, "CREA is ahead"]);
  eq("the removal is logged", msgs.some((m) => /finding removed because a number in it could not be verified/.test(m)), true);
  // numbers that code can correct are corrected in code: one model call, no regeneration
  calls = 0; CC.parseJ = () => [f("a", "CREA has 7 articles."), f("b", "TERI scores 47/100 on AEO."), f("c", "CREA: 100% data-specific.")];
  const fast = await Graph.run({ cfg: { CLAUDE_KEY: "x" }, data, ORGS, DATE_FROM: "2026-10-12", DATE_TO: "2026-10-18", orgSummary: "", cb: () => {} });
  eq("correctable wrong numbers: ONE model call, fixed in the text", [calls, fast.execF[0].headline + "|" + fast.execF[0].detail, fast.execF[1].detail, fast.execAudit.issues.length], [1, "a|CREA has 2 articles.", "TERI scores 31/100 on AEO.", 0]);
  // and a clean summary is untouched
  calls = 0; CC.parseJ = () => [f("a", "CREA has 2 articles."), f("b", "TERI scores 31/100 on AEO."), f("c", "CREA: 100% data-specific.")];
  const ok = await Graph.run({ cfg: { CLAUDE_KEY: "x" }, data, ORGS, DATE_FROM: "2026-10-12", DATE_TO: "2026-10-18", orgSummary: "", cb: () => {} });
  eq("a summary whose numbers are all right is untouched (1 call)", [calls, ok.execF.length, !!ok.execAudit.dropped], [1, 3, false]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
