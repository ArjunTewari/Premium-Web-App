import { logger } from "./logger.js";

// ── GitHub-backed report storage ────────────────────────────────────────────
// Generated report HTML used to live only on the Railway volume, growing
// without bound. It's now pushed to a dedicated GitHub repo instead — the
// repo is storage only, not app source. Local disk is still used as a
// write-through cache: a report is written locally first (pipeline.js is
// unchanged there), then routes/pipeline.ts uploads it here and deletes the
// local copy on success, so an upload hiccup never loses an already-paid-for
// report — it just stays local until the next successful upload attempt.
//
// A `manifest.json` at the repo root tracks {name, size, mtime} for every
// uploaded report so the Reports tab can list them with a single API call
// instead of paying for a directory listing (or a commit-date lookup) per
// file. Report content lives under `reports/<name>`.

const DEFAULT_REPO = "ArjunTewari/emerald-ai-reports";
const DEFAULT_BRANCH = "main";

function repo(): string {
  return process.env.GITHUB_REPORTS_REPO || DEFAULT_REPO;
}
function branch(): string {
  return process.env.GITHUB_REPORTS_BRANCH || DEFAULT_BRANCH;
}

export function isConfigured(): boolean {
  return !!process.env.GITHUB_REPORTS_TOKEN;
}

async function githubRequest(path: string, init?: RequestInit): Promise<Response | null> {
  const token = process.env.GITHUB_REPORTS_TOKEN;
  if (!token) return null;
  try {
    return await fetch(`https://api.github.com/repos/${repo()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    logger.warn({ err, path }, "GitHub report-storage request errored");
    return null;
  }
}

async function getFileSha(path: string): Promise<string | undefined> {
  const res = await githubRequest(`/contents/${path}?ref=${branch()}`);
  if (!res || !res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as { sha?: string };
  return body.sha;
}

// Create-or-update a file. Retries a few times on a sha conflict (another
// write landed between our GET and PUT) by re-fetching the latest sha —
// uploads are rare/slow relative to this window, so this is a safety net
// for concurrent runs, not the common case.
async function putFile(path: string, content: string, message: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sha = await getFileSha(path);
    const res = await githubRequest(`/contents/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: branch(),
        ...(sha ? { sha } : {}),
      }),
    });
    if (res?.ok) return true;
    if (res?.status === 409 || res?.status === 422) continue; // stale sha — retry
    logger.warn({ path, status: res?.status }, "GitHub report-storage write failed");
    return false;
  }
  logger.warn({ path }, "GitHub report-storage write failed after retries");
  return false;
}

export interface StoredReportMeta {
  name: string;
  size: number; // KB, matching the local-disk listing's units
  mtime: string; // ISO, sliced to 16 chars — matches the local-disk listing's format
}

interface Manifest {
  reports: StoredReportMeta[];
}

async function getManifest(): Promise<{ manifest: Manifest; sha?: string }> {
  const res = await githubRequest(`/contents/manifest.json?ref=${branch()}`);
  if (!res || !res.ok) return { manifest: { reports: [] }, sha: undefined };
  const body = (await res.json().catch(() => null)) as { content?: string; sha?: string } | null;
  if (!body?.content) return { manifest: { reports: [] }, sha: body?.sha };
  try {
    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Manifest;
    return { manifest: { reports: Array.isArray(parsed.reports) ? parsed.reports : [] }, sha: body.sha };
  } catch {
    return { manifest: { reports: [] }, sha: body.sha };
  }
}

// Upload one report's content and record it in the manifest. Returns true
// only once both the file and the manifest update succeeded.
export async function uploadReport(name: string, content: string): Promise<boolean> {
  if (!isConfigured()) return false;

  const wrote = await putFile(`reports/${name}`, content, `Add report: ${name}`);
  if (!wrote) return false;

  const size = Math.round(Buffer.byteLength(content, "utf8") / 1024);
  const mtime = new Date().toISOString().slice(0, 16);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { manifest, sha } = await getManifest();
    const next: Manifest = {
      reports: [...manifest.reports.filter((r) => r.name !== name), { name, size, mtime }],
    };
    const res = await githubRequest(`/contents/manifest.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Update manifest: ${name}`,
        content: Buffer.from(JSON.stringify(next, null, 2), "utf8").toString("base64"),
        branch: branch(),
        ...(sha ? { sha } : {}),
      }),
    });
    if (res?.ok) return true;
    if (res?.status === 409 || res?.status === 422) continue; // stale sha — retry
    logger.warn({ name, status: res?.status }, "GitHub manifest update failed");
    return false;
  }
  logger.warn({ name }, "GitHub manifest update failed after retries");
  return false;
}

export async function listReports(): Promise<StoredReportMeta[]> {
  if (!isConfigured()) return [];
  const { manifest } = await getManifest();
  return manifest.reports;
}

// Raw content fetch — sidesteps the Contents API's base64-in-JSON response,
// which GitHub caps well under our report sizes can reasonably reach.
export async function getReportContent(name: string): Promise<string | null> {
  if (!isConfigured()) return null;
  const res = await githubRequest(`/contents/reports/${encodeURIComponent(name)}?ref=${branch()}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (!res || !res.ok) return null;
  return await res.text();
}

// ── Per-report trend data (small JSON, one per report, alongside its HTML) ──
// Not tracked in manifest.json — that file only backs the Reports tab's HTML
// listing. The trends dashboard instead lists reports/*.json directly.
export async function uploadReportData(name: string, data: unknown): Promise<boolean> {
  if (!isConfigured()) return false;
  return putFile(`reports/${name}`, JSON.stringify(data, null, 2), `Add report data: ${name}`);
}

export async function listReportDataFiles(): Promise<string[]> {
  if (!isConfigured()) return [];
  const res = await githubRequest(`/contents/reports?ref=${branch()}`);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => null)) as { name?: string; type?: string }[] | null;
  if (!Array.isArray(body)) return [];
  return body
    .filter((f) => f.type === "file" && typeof f.name === "string" && f.name.endsWith(".json"))
    .map((f) => f.name as string);
}
