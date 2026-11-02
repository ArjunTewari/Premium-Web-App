// Run: node tests/weak-terms.test.cjs (needs the app's node_modules). No network, no Claude.
// A post that matches only a GENERAL term ("emission", "methane", "health impact", "thermal power") is not about air quality; it
// counts only together with a subject term. (26 Oct - 1 Nov run: CSE, ICCT and TERI social scores rested on posts about UNEP's
// Emissions Gap Report, EU car CO2 rules and a job titled "Emissions Accounting Expert".) In the climate framework the same
// words are core and still count.
const path = require("path");
const dir = path.join(__dirname, "..", "src", "pipeline");
const FW = require(path.join(dir, "frameworks")), C = require(path.join(dir, "apidirect-collector.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const li = (url, text) => ({ url, text, date: "2026-10-28T09:00:00Z", likes: 5, comments: 1, shares: 0 });
const count = (posts, kw) => C.reprocessLinkedIn("Org", { rawPosts: posts, rawMeta: { followers: 1000, source: "timeline", timelinePages: 1 } }, kw, () => {}).postCount;

FW.setActiveFramework("air-quality");
const kw = C.buildAqKeywords(["methane", "health impact", "thermal power", "stubble burning"]);
eq("UNEP Emissions Gap Report post does not count", count([li("a", "“The chance of holding global warming to below 1.5°C is gone,” flags UNEP in the Emissions Gap Report 2026. Swipe through.")], kw), 0);
eq("EU car CO2 standards / zero-emission target post does not count", count([li("b", "Weakening the EU’s CO₂ standards for cars could put up to 185,000 jobs at risk; the zero-emission target for 2035 is a driver of the transition.")], kw), 0);
eq("a hiring post for 'Transport Modelling and Emissions Accounting' does not count", count([li("c", "📢 We’re Hiring | Research Associate – Transport Modelling and Emissions Accounting Expert. TERI invites applications for a position.")], kw), 0);
eq("landfill methane / biogas posts do not count on their own", count([li("d", "Methane emissions from landfills are hard to track; satellite monitoring can help."), li("e", "Scaling biomethane and compressed biogas will be critical.")], kw), 0);
eq("'heat health impacts' and 'thermal power capacity' on their own do not count", count([li("f", "A heat study of exposure and associated health impacts of heat."), li("g", "Thermal power capacity additions reached a record 58.7 GW.")], kw), 0);
eq("the same general word WITH a subject term counts", count([li("h", "Vehicle emissions are a major driver of PM2.5 in Delhi this winter.")], kw), 1);
eq("a general word with 'air pollution' counts", count([li("i", "Cutting industrial emissions is the fastest way to reduce air pollution in our cities.")], kw), 1);
eq("a subject term on its own still counts", count([li("j", "AQI turned severe this week as stubble burning continued across Punjab.")], kw), 1);
eq("a post with two general words and nothing else does not count", count([li("k", "Methane and emissions: a new dashboard for district-level thermal power plants.")], kw), 0);

FW.setActiveFramework("climate");
const ckw = C.buildAqKeywords(["methane", "emission"]);
eq("in the climate framework the same words are core and count", count([li("l", "Methane emissions from landfills are hard to track; satellite monitoring can help.")], ckw), 1);
FW.setActiveFramework("air-quality");

// the partner-list rule: small words inside names do not break a list
const list = "Partners at the event: Ministry of Road Transport Commission for Air Quality Management YOURS - Youth for Road Safety Crashfree India Bharat Association of Road Safety Foundation Delhi Traffic Police Raahgiri Foundation";
eq("'Commission for Air Quality Management' inside a partner list does not make the post about air quality", count([li("m", `Urban Adda 2026 starts on Sunday in Connaught Place. ${list}`)], kw), 0);
eq("the same name in an ordinary sentence about air quality work still counts", count([li("n", "The Commission for Air Quality Management announced new GRAP measures to improve air quality across Delhi NCR this week.")], kw), 1);
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
