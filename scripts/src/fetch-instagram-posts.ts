import { writeFileSync } from "fs";

const username = process.argv[2];
const API_KEY  = process.argv[3] ?? process.env.APIDIRECT_API_KEY;

if (!username || !API_KEY || username.startsWith("<") || API_KEY.startsWith("<")) {
  console.error("Usage: npm run fetch-instagram -- <username> <YOUR_APIDIRECT_API_KEY>");
  console.error("Example: npm run fetch-instagram -- natgeo abc123");
  process.exit(1);
}

const ENDPOINT = "https://apidirect.io/v1/instagram/user/posts";

// Filter range: Feb 1 – May 31, 2026
const FROM = new Date("2026-02-01T00:00:00Z");
const TO   = new Date("2026-05-31T23:59:59Z");

// API cap is 10 pages (~12 posts/page). We fetch in steps of 4.
const PAGE_STEP = 4;
const PAGE_MAX  = 10;

const AQ_KEYWORDS = [
  "ncap",
  "policy regulations",
  "pm2.5",
  "exposure mapping",
  "stubble burning",
  "clean air finance",
  "vehicular pollution",
  "health impact",
  "industrial pollution",
  "heat-aqi",
  "brick kiln",
  "petrol emission",
  "diesel emission",
  "super emitter",
  "thermal power",
  "household pollution",
  "indoor pollution",
  "biomass",
  "rice residue",
  "wheat residue",
  "road dust",
];

interface Post {
  title?: string;
  url?: string;
  date?: string | number;
  author?: string;
  snippet?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
  is_video?: boolean;
  media_type?: string;
  thumbnail_url?: string;
  video_url?: string;
  hashtags?: string[];
  is_pinned?: boolean;
  [key: string]: unknown;
}

interface ApiResponse {
  posts?: Post[];
  pages?: number;
  count?: number;
  error?: string;
}

function parseDate(raw: string | number | undefined): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return new Date(raw * 1000);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function matchedKeywords(post: Post): string[] {
  const text = [
    post.title ?? "",
    post.snippet ?? "",
    ...(post.hashtags ?? []),
  ].join(" ").toLowerCase();
  return AQ_KEYWORDS.filter((kw) => text.includes(kw));
}

async function fetchPosts(pages: number): Promise<ApiResponse> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("username", username.replace(/^@/, ""));
  url.searchParams.set("pages", String(pages));

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": API_KEY! },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json() as Promise<ApiResponse>;
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.error(`Fetching Instagram posts for @${username.replace(/^@/, "")}`);
console.error(`Target range: ${FROM.toDateString()} → ${TO.toDateString()}`);

let allPosts: Post[] = [];
let reachedBeforeFeb = false;

for (let pages = PAGE_STEP; pages <= PAGE_MAX; pages = Math.min(pages + PAGE_STEP, PAGE_MAX)) {
  console.error(`\nFetching ${pages} page(s) (~${pages * 12} posts)...`);

  const data = await fetchPosts(pages);

  if (data.error) {
    console.error(`API error: ${data.error}`);
    process.exit(1);
  }

  const posts = data.posts ?? [];
  console.error(`  Got ${posts.length} posts total.`);

  allPosts = posts;

  const dates = posts.map((p) => parseDate(p.date)).filter(Boolean) as Date[];
  if (dates.length > 0) {
    const oldest = new Date(Math.min(...dates.map((d) => d.getTime())));
    console.error(`  Oldest post date: ${oldest.toDateString()}`);
    if (oldest < FROM) {
      console.error(`  → Crossed Feb 1 — stopping pagination.`);
      reachedBeforeFeb = true;
      break;
    }
  }

  if (pages === PAGE_MAX) {
    console.error(`  → Reached API page limit (${PAGE_MAX}). Stopping.`);
    break;
  }
}

// Filter to Feb 1 – May 31, then filter by keywords
const inRange = allPosts.filter((p) => {
  const d = parseDate(p.date);
  return d !== null && d >= FROM && d <= TO;
});

const matched = inRange
  .map((p) => ({ url: p.url, date: p.date, keywords_found: matchedKeywords(p) }))
  .filter((p) => p.keywords_found.length > 0);

const skipped = inRange.length - matched.length;

console.error(`\nIn date range: ${inRange.length} posts`);
console.error(`Keyword match: ${matched.length} kept, ${skipped} skipped (no AQ keywords)`);
if (!reachedBeforeFeb) {
  console.error("Warning: did not reach Feb 1 within API page limit — some Feb posts may be missing.");
}

const result = {
  username: username.replace(/^@/, ""),
  fetched_at: new Date().toISOString(),
  range: { from: FROM.toISOString(), to: TO.toISOString() },
  reached_before_feb: reachedBeforeFeb,
  total_fetched: allPosts.length,
  total_in_range: inRange.length,
  total_matched: matched.length,
  posts: matched,
};

const clean = username.replace(/^@/, "").replace(/[^a-z0-9_]/gi, "_");
const ts    = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
const out   = `instagram-${clean}-${ts}.json`;

writeFileSync(out, JSON.stringify(result, null, 2), "utf-8");
console.error(`Saved → ${out}`);

console.log(JSON.stringify(result, null, 2));
