import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env from repo root if FIRECRAWL_KEY not already in environment
if (!process.env.FIRECRAWL_KEY) {
  const envPath = resolve(import.meta.dirname, "../../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const [key, ...rest] = line.trim().split("=");
      if (key && !key.startsWith("#") && !(key in process.env)) {
        process.env[key] = rest.join("=").trim();
      }
    }
  }
}

const FC_KEY = process.env.FIRECRAWL_KEY;
if (!FC_KEY) {
  console.error("Error: FIRECRAWL_KEY is not set.");
  console.error("Add FIRECRAWL_KEY=fc-xxx to your .env file at the repo root.");
  process.exit(1);
}

const ENDPOINT = "https://api.firecrawl.dev/v2/search";

const AQ_KEYWORDS = [
  "ncap",
  "policy regulations",
  "pm2.5",
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
  "air quality",
];

const ORGS = [
  { name: "CSTEP",                             query: 'air quality CSTEP' },
  { name: "Centre for Science and Environment", query: 'air quality "Centre for Science and Environment"' },
  { name: "EPIC India",                        query: 'air quality "EPIC India"' },
];

const SHARED_PARAMS = {
  sources: ["news"],
  includeDomains: ["news18.com", "indiatoday.in", "ndtv.com"],
  tbs: "cdr:1,cd_min:2/1/2026,cd_max:5/31/2026",
  limit: 15,
  scrapeOptions: {
    formats: ["summary"],
  },
};

interface Article {
  title: string;
  url: string;
  snippet?: string;
  description: string;
  date?: string;
  summary?: string;
}

interface FirecrawlResponse {
  success: boolean;
  data?: { web?: Article[]; news?: Article[] };
  warning?: string;
  error?: string;
}

function matchedKeywords(item: Article): string[] {
  const text = `${item.title} ${item.description} ${item.snippet ?? ""} ${item.summary ?? ""}`.toLowerCase();
  return AQ_KEYWORDS.filter((kw) => text.includes(kw));
}

async function search(query: string, attempt = 1): Promise<Article[]> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FC_KEY}` },
      body: JSON.stringify({ query, ...SHARED_PARAMS }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const json = (await res.json()) as FirecrawlResponse;
    if (!json.success) throw new Error(json.error ?? "unknown error");
    if (json.warning) console.error(`[warn] ${json.warning}`);

    return json.data?.news ?? json.data?.web ?? [];
  } catch (err) {
    if (attempt < 3) {
      const wait = attempt * 5_000;
      console.error(`[retry ${attempt}/3] failed, retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      return search(query, attempt + 1);
    }
    throw err;
  }
}

const grouped: Record<string, object[]> = {};
let totalRaw = 0;
let totalKept = 0;

for (const { name, query } of ORGS) {
  console.error(`Searching: ${name}...`);
  const raw = await search(query);
  totalRaw += raw.length;

  const seen = new Set<string>();
  const articles: object[] = [];
  let skipped = 0;

  for (const item of raw) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const keywords_found = matchedKeywords(item);
    if (keywords_found.length === 0) { skipped++; continue; }
    articles.push({ title: item.title, url: item.url, date: item.date, description: item.description, keywords_found });
  }

  grouped[name] = articles;
  totalKept += articles.length;
  console.error(`  ${name}: ${articles.length} kept (${skipped} filtered out)`);
}

const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
const outFile = `3monthcheckfinal-${timestamp}.json`;
writeFileSync(outFile, JSON.stringify(grouped, null, 2), "utf-8");
console.error(`\nTotal: ${totalKept} articles (from ${totalRaw} raw)`);
console.error(`Saved to ${outFile}`);
