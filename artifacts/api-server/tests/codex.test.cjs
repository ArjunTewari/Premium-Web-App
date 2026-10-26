// Run: node tests/codex.test.cjs  (needs the app's node_modules). No network, no Codex.
// ChatGPT is asked through the Codex CLI signed in with ChatGPT — never the OpenAI API.
const path = require("path"); const os = require("os"); const fs = require("fs");
const dir = path.join(__dirname, "..", "src", "pipeline");
const Codex = require(path.join(dir, "codex-cli.js"));
const SI = require(path.join(dir, "social-intelligence.js"));
const Audit = require(path.join(dir, "audit.js"));
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

// ── no API key can reach the CLI; only a ChatGPT sign-in is accepted ──
process.env.OPENAI_API_KEY = "sk-a"; process.env.CODEX_API_KEY = "sk-b"; process.env.OPENAI_KEY = "sk-c";
const env = Codex.childEnv();
eq("API keys are removed from the CLI's environment", [env.OPENAI_API_KEY, env.CODEX_API_KEY, env.OPENAI_KEY], [undefined, undefined, undefined]);
process.env.CODEX_AUTH_JSON = "{bad";
let msg = ""; try { Codex.childEnv(); } catch (e) { msg = e.message; }
eq("a damaged CODEX_AUTH_JSON is refused", /not valid JSON/.test(msg), true);
process.env.CODEX_AUTH_JSON = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-d" });
msg = ""; try { Codex.childEnv(); } catch (e) { msg = e.message; }
eq("an API-key sign-in is refused", /ChatGPT sign-in/.test(msg), true);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
process.env.CODEX_HOME = home; process.env.CODEX_AUTH_JSON = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "x" } });
const env2 = Codex.childEnv();
eq("a ChatGPT sign-in is placed in the private CODEX_HOME, and the variable itself is not passed on", [env2.CODEX_HOME === home, fs.existsSync(path.join(home, "auth.json")), env2.CODEX_AUTH_JSON], [true, true, undefined]);
fs.writeFileSync(path.join(home, "auth.json"), '{"refreshed":true}');
Codex.childEnv();
eq("a refreshed sign-in already in CODEX_HOME is kept, not overwritten", fs.readFileSync(path.join(home, "auth.json"), "utf8"), '{"refreshed":true}');
delete process.env.CODEX_AUTH_JSON; delete process.env.CODEX_HOME;

// ── reading a batch reply ──
eq("a JSON array reply with the right length is read", Codex.parseAnswers('["a","b","c"]', 3), ["a", "b", "c"]);
eq("fenced / wrapped replies are read", Codex.parseAnswers('Here:\n```json\n["x","y"]\n```', 2), ["x", "y"]);
let bad1 = "", bad2 = "";
try { Codex.parseAnswers('["a","b"]', 3); } catch (e) { bad1 = e.message; }
try { Codex.parseAnswers("no array here", 2); } catch (e) { bad2 = e.message; }
eq("a wrong number of answers, or no array, is an error — never padded", [/2 answers for 3/.test(bad1), /not a JSON array/.test(bad2)], [true, true]);

// ── the AI-visibility probe uses Codex, in batches ──
(async () => {
  const batches = [];
  Codex.askChatGPTBatch = async (qs) => { batches.push(qs.length); return qs.map((q) => (/Q3|third/.test(q) ? "Council on Energy, Environment and Water; CREA" : "Centre for Science and Environment; TERI")); };
  const cfg = { OPENAI_KEY: "codex-cli", AEO_QUERIES: ["first?", "second?", "third question?", "fourth?", "fifth?", "sixth?", "seventh?"] };
  const lines = [];
  const r = await SI.runAEO(cfg, ["Centre for Science and Environment", "CREA", "WRI India"], (m) => lines.push(m));
  eq("7 questions go as batches of 5 + 2", batches.slice().sort(), [2, 5]);
  const cse = r["Centre for Science and Environment"], crea = r["CREA"], wri = r["WRI India"];
  eq("mentions are counted per organisation from ChatGPT's answers", [cse.llmBreakdown.ChatGPT.mentions, crea.llmBreakdown.ChatGPT.mentions, wri.llmBreakdown.ChatGPT.mentions], [6, 1, 0]);
  eq("the assistant is labelled ChatGPT and no call failed", [Object.keys(cse.llmBreakdown), cse.llmBreakdown.ChatGPT.failed, cse.questionResults.Q1[0].llm], [["ChatGPT"], 0, "ChatGPT"]);

  // a batch that cannot be answered is recorded as missing, not as zero mentions
  let n = 0;
  Codex.askChatGPTBatch = async (qs) => { n++; throw new Error("Codex CLI was rate limited"); };
  const r2 = await SI.runAEO({ OPENAI_KEY: "codex-cli", AEO_QUERIES: ["a?", "b?"] }, ["CREA"], () => {});
  eq("a failing batch is tried twice, then recorded as failed", [n, r2.CREA.llmBreakdown.ChatGPT.failed, r2.CREA.llmBreakdown.ChatGPT.total], [2, 2, 2]);
  Codex.askChatGPTBatch = async () => { const e = new Error("not signed in"); e.auth = true; n++; throw e; };
  n = 0; await SI.runAEO({ OPENAI_KEY: "codex-cli", AEO_QUERIES: ["a?"] }, ["CREA"], () => {});
  eq("a sign-in problem is not retried", n, 1);

  // the audit refuses a report whose ChatGPT probe got no answers, and warns on a partial failure
  const ORGS = ["CREA"];
  const base = { ORGS, data: { CREA: { sov: 1, aeo: 0, social: 0, pressShare: 100, llmShare: 100, socialShare: 100, score: 100 } }, socialERResults: [], execF: [] };
  let a = Audit.checkDeterministic({ ...base, aeoResults: r2 });
  eq("all ChatGPT questions failed -> audit error (a zero would be missing data)", a.errors.some((e) => /returned no answers/.test(e.issue)), true);
  const partial = { CREA: { llmBreakdown: { ChatGPT: { mentions: 1, total: 15, failed: 5 } } } };
  a = Audit.checkDeterministic({ ...base, aeoResults: partial });
  eq("some failed -> warning only", [a.errors.some((e) => /ChatGPT/.test(e.issue)), a.warnings.some((w) => /5 of 15 questions to ChatGPT/.test(w.issue))], [false, true]);
  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
