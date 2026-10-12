// Pre-run check of the paid services a report depends on.
//
// On 12 Oct 2026 a run went ahead with the Anthropic account out of credit, an
// invalid OpenAI key, a refused APIdirect account and an exhausted YouTube quota.
// Every failed call was recorded as "nothing found": articles were dropped as
// "unverified", AI visibility showed 0, the executive summary and action matrix
// were empty — and the finished report was stored (overwriting an earlier one)
// and emailed as if it were real. A few cheap calls up front catch this before
// any money is spent or anything is stored.
//
// Fatal  — the report would be wrong or empty without it (aborts the run):
//          Claude (article classification, summary, actions), APIdirect
//          (LinkedIn / X / Instagram), OpenAI when a key is set.
// Warning — the report is still useful and the gap is visible in it:
//          YouTube (cells show ✕), Perplexity (not checked: no free endpoint).

export interface PreflightResult {
  fatal: string[];
  warnings: string[];
  checked: string[];
}

type FetchFn = typeof fetch;

interface PreflightConfig {
  CLAUDE_KEY?: string;
  OPENAI_KEY?: string;
  YOUTUBE_KEY?: string;
  APIDIRECT_KEY?: string;
}

async function body(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string };
      const e = typeof j.error === "string" ? j.error : j.error?.message;
      return (e || j.message || t).toString().slice(0, 200);
    } catch {
      return t.slice(0, 200);
    }
  } catch {
    return "";
  }
}

export async function preflight(cfg: PreflightConfig, fetchImpl: FetchFn = fetch): Promise<PreflightResult> {
  const out: PreflightResult = { fatal: [], warnings: [], checked: [] };
  const signal = () => AbortSignal.timeout(15000);

  const tasks: Promise<void>[] = [];

  if (cfg.CLAUDE_KEY) {
    tasks.push((async () => {
      out.checked.push("Claude");
      try {
        const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": cfg.CLAUDE_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: signal(),
        });
        if (res.ok || res.status === 429 || res.status === 529) return; // reachable; rate limits are transient
        out.fatal.push(`Claude (Anthropic) refused the request: ${await body(res) || `HTTP ${res.status}`}`);
      } catch (e) {
        out.warnings.push(`Claude could not be reached to check it (${(e as Error).message}); continuing.`);
      }
    })());
  }

  if (cfg.OPENAI_KEY) {
    tasks.push((async () => {
      out.checked.push("OpenAI");
      try {
        const res = await fetchImpl("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${cfg.OPENAI_KEY}` }, signal: signal() });
        if (res.ok || res.status === 429) return;
        if (res.status === 401 || res.status === 403) {
          out.fatal.push(`OpenAI key was refused: ${await body(res) || `HTTP ${res.status}`}`);
        } else {
          out.warnings.push(`OpenAI check returned HTTP ${res.status}; continuing.`);
        }
      } catch (e) {
        out.warnings.push(`OpenAI could not be reached to check it (${(e as Error).message}); continuing.`);
      }
    })());
  }

  if (cfg.APIDIRECT_KEY) {
    tasks.push((async () => {
      out.checked.push("APIdirect");
      try {
        const u = new URL("https://apidirect.io/v1/linkedin/company");
        u.searchParams.set("url", "https://www.linkedin.com/company/linkedin");
        const res = await fetchImpl(u, { headers: { "X-API-Key": cfg.APIDIRECT_KEY! }, signal: signal() });
        if (res.ok || res.status === 429) return;
        out.fatal.push(`APIdirect refused the request (LinkedIn / X / Instagram would all fail): ${await body(res) || `HTTP ${res.status}`}`);
      } catch (e) {
        out.warnings.push(`APIdirect could not be reached to check it (${(e as Error).message}); continuing.`);
      }
    })());
  }

  if (cfg.YOUTUBE_KEY) {
    tasks.push((async () => {
      out.checked.push("YouTube");
      try {
        const u = new URL("https://www.googleapis.com/youtube/v3/channels");
        u.searchParams.set("part", "id");
        u.searchParams.set("forHandle", "@YouTube");
        u.searchParams.set("key", cfg.YOUTUBE_KEY!);
        const res = await fetchImpl(u, { signal: signal() });
        if (res.ok) return;
        out.warnings.push(`YouTube data will be missing (shown as ✕ in the report): ${await body(res) || `HTTP ${res.status}`}`);
      } catch (e) {
        out.warnings.push(`YouTube could not be reached to check it (${(e as Error).message}); continuing.`);
      }
    })());
  }

  await Promise.all(tasks);
  return out;
}
