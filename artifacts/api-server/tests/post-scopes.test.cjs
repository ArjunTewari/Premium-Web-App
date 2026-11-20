// Run: node tests/post-scopes.test.cjs. No network, no dependencies, no Claude.
// Every post of a period is collected once, and put in exactly one scope; what the model does not answer is left unlabelled.
const path = require("path");
const S = require(path.join(__dirname, "..", "src", "pipeline", "post-scopes.js"));
let fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `\n  got ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); };

const saved = [
  {
    org: "A",
    liData: { rawPosts: [
      { url: "https://li/1", text: "Delhi smog  worsens", date: "2026-11-03 10:00:00", likes: "5", comments: "1", shares: "2" },
      { url: "https://li/1", text: "Delhi smog worsens", date: "2026-11-03 10:00:00", likes: "5", comments: "1", shares: "2" },            // same address twice
      { url: "https://li/2", text: "Delhi smog  worsens", date: "2026-11-04 10:00:00", likes: "5", comments: "1", shares: "2" },            // same message, same engagement: a copy
      { url: "https://li/3", text: "Too early", date: "2026-10-30 10:00:00", likes: "1", comments: "0", shares: "0" },                       // outside the period
    ] },
    twData: { rawTweets: [
      { url: "https://x/1", text: "a tweet", date: "2026-11-05 09:00:00", likes: "3", replies: "1", retweets: "0", views: "40", is_retweet: "False" },
      { url: "https://x/2", text: "RT someone", date: "2026-11-05 09:00:00", likes: "0", replies: "0", retweets: "0", views: "0", is_retweet: "True" },
    ] },
    igData: { rawPosts: [{ url: "https://ig/1", snippet: "a photo", date: "2026-11-08 23:59:59", likes: "9", comments: "0", views: "100" }] },
  },
  { org: "B", liData: null, twData: {}, igData: undefined },
];
const posts = S.collectPosts(saved, "2026-11-02", "2026-11-08");
eq("one record per post (newest first), retweets / copies / out-of-period left out", posts.map((p) => p.id), ["ig:https://ig/1", "x:https://x/1", "li:https://li/1"]);
const by = (id) => posts.find((p) => p.id === id);
eq("text is cleaned and engagement is numbers", [by("li:https://li/1").text, by("li:https://li/1").likes, by("li:https://li/1").comments, by("li:https://li/1").shares], ["Delhi smog worsens", 5, 1, 2]);
eq("X replies are comments, retweets are shares, views kept", [by("x:https://x/1").comments, by("x:https://x/1").shares, by("x:https://x/1").views], [1, 0, 40]);
eq("an organisation with no saved posts adds nothing", S.collectPosts([{ org: "B" }], "2026-11-02", "2026-11-08"), []);

eq("labels are read from a reply, bad entries ignored", S.parseLabels('Sure: [{"i":0,"s":"AQ"},{"i":1,"s":"zz"},{"i":9,"s":"CL"},{"i":2,"s":"su"}]', 3), { 0: "air-quality", 2: "sustainability" });
eq("a reply without JSON gives no labels", S.parseLabels("I cannot", 3), {});
eq("the prompt lists every post by number", S.batchPrompt(posts).includes("[0] (Instagram, A) a photo"), true);

(async () => {
  // a model that answers everything the first time
  let calls = 0;
  const ok = async (prompt) => { calls++; const n = (prompt.match(/^\[\d+\]/gm) || []).length; return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, s: i === 0 ? "AQ" : "OT" }))); };
  const cache = {};
  await S.labelPosts(posts, { askClaude: ok, cache, batchSize: 30 });
  eq("every post gets one scope", posts.map((p) => p.scope), ["air-quality", "other", "other"]);
  eq("one call for a batch", calls, 1);
  await S.labelPosts(posts, { askClaude: ok, cache });
  eq("a post already labelled is not asked again", calls, 1);

  // a model that forgets one post the first time and answers it the second
  const fresh = S.collectPosts(saved, "2026-11-02", "2026-11-08");
  let n2 = 0;
  const forgetful = async (prompt) => { n2++; const n = (prompt.match(/^\[\d+\]/gm) || []).length; return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, s: "CL" })).slice(n2 === 1 ? 1 : 0)); };
  await S.labelPosts(fresh, { askClaude: forgetful, cache: {} });
  eq("a post the model skipped is asked again", [fresh.map((p) => p.scope), n2], [["climate", "climate", "climate"], 2]);

  // a model that always fails: nothing is guessed
  const bad = S.collectPosts(saved, "2026-11-02", "2026-11-08");
  await S.labelPosts(bad, { askClaude: async () => { throw new Error("down"); }, cache: {} });
  eq("a failed batch is left unlabelled, not guessed", bad.map((p) => p.scope), [null, null, null]);

  const ds = S.buildDataset({ posts: bad, from: "2026-11-02", to: "2026-11-08", framework: "air-quality", orgs: ["A", "B"], reportName: "x" });
  eq("the dataset says how many posts have no scope", [ds.unlabelled, ds.posts.length, ds.scopes.map((s) => s.id)], [3, 3, ["air-quality", "climate", "sustainability", "other"]]);
  eq("the dataset uses short keys", Object.keys(ds.posts[0]).join(","), "o,p,s,d,t,u,l,c,h,v");

  console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
})();
