import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

const LOADING_QUOTES = [
  { text: "Clean air is not a privilege — it is a right.", author: "UN Environment Programme" },
  { text: "Every data point tells a story of the air we share.", author: "Emerald AI" },
  { text: "Awareness precedes action. Intelligence precedes awareness.", author: "Emerald AI" },
  { text: "The quality of our air reflects the quality of our decisions.", author: "WHO" },
  { text: "Media intelligence reveals who is shaping the conversation.", author: "Emerald AI" },
  { text: "PM2.5 is invisible. Its impact is not.", author: "Health Effects Institute" },
  { text: "Tracking who speaks about clean air is the first step to changing it.", author: "Emerald AI" },
  { text: "The atmosphere has no political boundaries.", author: "Emerald AI" },
  { text: "Good journalism begins with reliable data.", author: "Emerald AI" },
  { text: "Information is the oxygen of the modern age.", author: "Ronald Reagan" },
  { text: "Science is the key to our future, and if you don't believe in science, then you're holding everyone back.", author: "Bill Nye" },
  { text: "What gets measured gets managed.", author: "Peter Drucker" },
];

const DEFAULT_ORGS = [
  "WRI India",
  "Air Pollution Action Group",
  "Chintan Environmental Research and Action Group",
  "IIT Kanpur",
  "CSTEP",
  "IIT Delhi",
  "Health Effects Institute",
  "ICCT",
  "EPIC India",
  "Council on Energy, Environment and Water",
  "Centre for Science and Environment",
  "Climate Trends",
  "Sustainable Futures Collaborative",
];

const ORG_YT_HANDLES: Record<string, string> = {
  "WRI India":                                        "https://www.youtube.com/channel/UCYoSZhQQR6Pc9lFJjR5e18g",
  "Air Pollution Action Group":                       "",
  "Chintan Environmental Research and Action Group":  "https://www.youtube.com/channel/UCg-HN_sFTRBNDDOWxEt138g",
  "IIT Kanpur":                                       "https://www.youtube.com/channel/UCIdajcgyfqnD9PwDnv_xqmg",
  "CSTEP":                                            "",
  "IIT Delhi":                                        "https://www.youtube.com/channel/UCJX9RwRoVAEFLWlhrNF3Lqg",
  "Health Effects Institute":                         "https://www.youtube.com/channel/UCPli-nivc67QzWoW1nRumIw",
  "ICCT":                                             "https://www.youtube.com/channel/UCjbSjAMN6yiGhczNwSgTJ6Q",
  "EPIC India":                                       "https://www.youtube.com/channel/UCz-PtdD6pJSITzGt7q9gN8A",
  "Council on Energy, Environment and Water":         "https://www.youtube.com/channel/UCNF-vGnm1jdA_jhrIpk84Tg",
  "Centre for Science and Environment":               "https://www.youtube.com/channel/UCPUL9ZjjcobQ6XlgTo6Mr2g",
  "Climate Trends":                                   "https://www.youtube.com/channel/UCed9gfyM-3SAGIAYpvSz8ig",
  "Sustainable Futures Collaborative":                "https://www.youtube.com/channel/UCZcWNjwTwQK48D7z8oWAKCA",
};

const ORG_TW_HANDLES: Record<string, string> = {
  "Council on Energy, Environment and Water":         "CEEWIndia",
  "Centre for Science and Environment":               "cseindia",
  "WRI India":                                        "wriindia",
  "CSTEP":                                            "CSTEP_India",
  "Air Pollution Action Group":                       "APAGIndia",
  "Chintan Environmental Research and Action Group":  "chintanindia",
  "IIT Delhi":                                        "iitdelhi",
  "IIT Kanpur":                                       "IITKanpur",
  "Health Effects Institute":                         "",
  "ICCT":                                             "theicct",
  "EPIC India":                                       "epiccampglobal",
  "Climate Trends":                                   "ClimateTrendsIN",
  "Sustainable Futures Collaborative":                "SFC_India",
};

const ORG_IG_HANDLES: Record<string, string> = {
  "Council on Energy, Environment and Water":         "ceewindia",
  "Centre for Science and Environment":               "cseindia",
  "WRI India":                                        "wri_india",
  "CSTEP":                                            "cstep_ind",
  "Air Pollution Action Group":                       "",
  "Chintan Environmental Research and Action Group":  "chintan.india",
  "IIT Delhi":                                        "iitdelhi",
  "IIT Kanpur":                                       "iit.kanpur",
  "Health Effects Institute":                         "",
  "ICCT":                                             "",
  "EPIC India":                                       "campepicglobal",
  "Climate Trends":                                   "climatrendsin",
  "Sustainable Futures Collaborative":                "sustainablefuturescollab",
};

const ORG_LI_HANDLES: Record<string, string> = {
  "Council on Energy, Environment and Water":         "ceew-council-on-energy-environment-and-water",
  "Centre for Science and Environment":               "centre-for-science-and-environment",
  "WRI India":                                        "wri-india",
  "CSTEP":                                            "",
  "Air Pollution Action Group":                       "",
  "Chintan Environmental Research and Action Group":  "chintan-environmental-research-and-action-group",
  "IIT Delhi":                                        "indian-institute-of-technology-delhi",
  "IIT Kanpur":                                       "iit-kanpur",
  "Health Effects Institute":                         "health-effects-institute",
  "ICCT":                                             "international-council-on-clean-transportation",
  "EPIC India":                                       "",
  "Climate Trends":                                   "",
  "Sustainable Futures Collaborative":                "",
};

const DEFAULT_SCOPE = [
  "AQI", "PM2.5", "PM10", "air pollution", "air quality", "smog",
  "clean air", "NCAP", "GRAP", "Black Carbon", "Ozone", "Ammonia",
  "Carbon Monoxide", "Nitrogen Dioxide", "Methane",
];

const DEFAULT_AEO_QUERIES = [
  "Which organisations are leading research on air quality and pollution in India?",
  "Who are the top experts or organisations working on PM2.5 reduction in South Asia?",
  "What NGOs or think tanks are most active in India's clean air campaign?",
  "Which Indian institutions publish the most reliable air quality data?",
  "Who is doing the most important work on air pollution policy in India?",
  "What organisations are partnering with the Indian government on NCAP implementation?",
  "Which research groups are tracking air quality index trends in Indian cities?",
  "Who produces peer-reviewed research on indoor and outdoor air pollution in India?",
  "What civil society groups are advocating for stricter emission standards in India?",
  "Which organisations are monitoring industrial air pollution in India?",
  "Who are the key voices on air quality health impacts in the Indian context?",
  "What institutions are involved in real-time AQI monitoring networks across India?",
  "Which think tanks influence air quality regulation and policy in India?",
  "Who is leading awareness campaigns about smog and vehicular pollution in India?",
  "What organisations collaborate internationally on South Asian air quality issues?",
];

interface ReportFile {
  name: string;
  size: number;
  mtime: string;
  costInr: string | null;
}

type LogLevel = "head" | "ok" | "warn" | "err" | "";

interface LogEntry {
  msg: string;
  level: LogLevel;
}

/* ── Slide-up animation hook ─────────────────────────────────────────────── */
function useSlideUp(delay = 0) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return visible;
}

function SlideUp({
  children,
  delay = 0,
  style = {},
}: {
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}) {
  const visible = useSlideUp(delay);
  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(18px)",
        transition: "opacity 0.5s cubic-bezier(.22,1,.36,1), transform 0.5s cubic-bezier(.22,1,.36,1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── Count-up number ─────────────────────────────────────────────────────── */
function CountUp({ target, suffix = "" }: { target: number; suffix?: string }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let cur = 0;
    const step = Math.max(1, Math.ceil(target / 40));
    const iv = setInterval(() => {
      cur = Math.min(cur + step, target);
      setVal(cur);
      if (cur >= target) clearInterval(iv);
    }, 28);
    return () => clearInterval(iv);
  }, [target]);
  return <>{val.toLocaleString()}{suffix}</>;
}

/* ── Token colours ───────────────────────────────────────────────────────── */
const C = {
  bg:        "var(--bg-app)",
  surface:   "var(--elevate-1)",
  border:    "var(--border-col)",
  gold:      "var(--accent-amber)",
  goldLight: "var(--accent-amber)",
  green:     "var(--accent-green)",
  muted:     "var(--text-sub)",
  text:      "var(--text-main)",
  textHi:    "var(--text-main)",
};

/* ── Shared input style ──────────────────────────────────────────────────── */
const inputStyle: React.CSSProperties = {
  background: "var(--elevate-1)",
  border: `1px solid var(--border-col)`,
  borderRadius: 8,
  padding: "8px 12px",
  color: C.text,
  fontFamily: "'DM Mono', monospace",
  fontSize: 18,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  colorScheme: "light dark",
  transition: "border-color .2s",
};

/* ── Module-level card/label components (must be outside Home to avoid remount on re-render) ── */
function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: "20px 22px",
      transition: "border-color .3s",
      ...style,
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", color: C.gold, marginBottom: 14 }}>
      {children}
    </div>
  );
}

export default function Home() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  const [selectedOrgs, setSelectedOrgs] = useState<string[]>(["Council on Energy, Environment and Water", "CSTEP"]);
  const [customOrgs, setCustomOrgs] = useState<{ name: string; ytHandle: string }[]>([]);
  const [orgCustomInput, setOrgCustomInput] = useState("");
  const [orgYtHandleInput, setOrgYtHandleInput] = useState("");

  // Unified social handles — pre-populated from hardcoded defaults, user-editable
  const [handlesOpen, setHandlesOpen] = useState(false);
  const [orgHandleOverrides, setOrgHandleOverrides] = useState<Record<string, { twitter: string; instagram: string; youtube: string; linkedin: string }>>(() => {
    const defaults: Record<string, { twitter: string; instagram: string; youtube: string; linkedin: string }> = {};
    for (const org of DEFAULT_ORGS) {
      defaults[org] = {
        twitter:   ORG_TW_HANDLES[org] || "",
        instagram: ORG_IG_HANDLES[org] || "",
        youtube:   ORG_YT_HANDLES[org] || "",
        linkedin:  ORG_LI_HANDLES[org] || "",
      };
    }
    try {
      const saved = localStorage.getItem("emerald_handles");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, { twitter: string; instagram: string; youtube: string; linkedin: string }>;
        return { ...defaults, ...parsed };
      }
    } catch {}
    return defaults;
  });
  const [handlesSaved, setHandlesSaved] = useState(false);

  const [dateFrom, setDateFrom] = useState("2026-03-08");
  const [dateTo, setDateTo] = useState("2026-06-08");
  const [clientName, setClientName] = useState("Chetan Bhattacharji");

  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeKeywords, setScopeKeywords] = useState<string[]>([...DEFAULT_SCOPE]);
  const [scopeInput, setScopeInput] = useState("");

  const [aeoOpen, setAeoOpen] = useState(false);
  const [aeoQueries, setAeoQueries] = useState<string[]>([...DEFAULT_AEO_QUERIES]);
  const [aeoInput, setAeoInput] = useState("");
  const [aeoEditIdx, setAeoEditIdx] = useState<number | null>(null);
  const [aeoEditVal, setAeoEditVal] = useState("");

  const [confirmState, setConfirmState] = useState<{ message: string; onConfirm: () => void } | null>(null);
  function withConfirm(message: string, action: () => void) { setConfirmState({ message, onConfirm: action }); }

  const [activeTab, setActiveTab] = useState<"dashboard" | "reports" | "handles">("dashboard");

  // Handles tab — new org add form
  const [hNewOrg, setHNewOrg]   = useState("");
  const [hNewTw,  setHNewTw]    = useState("");
  const [hNewIg,  setHNewIg]    = useState("");
  const [hNewYt,  setHNewYt]    = useState("");
  const [hNewLi,  setHNewLi]    = useState("");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [trendStatus, setTrendStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const [result, setResult] = useState<{ htmlName: string; costInr?: number } | null>(null);
  const [prevReports, setPrevReports] = useState<ReportFile[]>([]);

  const logBoxRef = useRef<HTMLDivElement>(null);
  const [quoteIdx, setQuoteIdx] = useState(0);

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setQuoteIdx(i => (i + 1) % LOADING_QUOTES.length), 4200);
    return () => clearInterval(iv);
  }, [running]);

  function detectPhase(entries: LogEntry[]): string {
    const last = [...entries].reverse().find(l => l.msg?.trim());
    if (!last) return "Initialising…";
    const m = last.msg.toLowerCase();
    if (m.includes("done") || m.includes("✓")) return "Finalising report…";
    if (m.includes("html") || m.includes("build") || m.includes("render")) return "Compiling intelligence report…";
    if (m.includes("social") || m.includes("twitter") || m.includes("instagram") || m.includes("linkedin")) return "Measuring social engagement…";
    if (m.includes("youtube")) return "Analysing YouTube presence…";
    if (m.includes("aeo") || m.includes("claude") || m.includes("haiku") || m.includes("gpt") || m.includes("perplexity") || m.includes("gemini") || m.includes("sonar")) return "Running AI visibility probes…";
    if (m.includes("tv") || m.includes("television") || m.includes("broadcast")) return "Scanning TV broadcast coverage…";
    if (m.includes("scrape") || m.includes("article")) return "Reading article content…";
    if (m.includes("serper") || m.includes("search") || m.includes("site:")) return "Searching news archives…";
    return "Processing data…";
  }

  const allOrgs = [...DEFAULT_ORGS, ...customOrgs.map(o => o.name)];
  const orgCount = selectedOrgs.length;

  // Derived handle maps — read from orgHandleOverrides (user-editable)
  const allOrgHandles: Record<string, string> = Object.fromEntries(
    Object.entries(orgHandleOverrides).map(([org, h]) => [org, h.youtube]).filter(([, v]) => v)
  );
  const allTwHandles: Record<string, string> = Object.fromEntries(
    Object.entries(orgHandleOverrides).map(([org, h]) => [org, h.twitter]).filter(([, v]) => v)
  );
  const allIgHandles: Record<string, string> = Object.fromEntries(
    Object.entries(orgHandleOverrides).map(([org, h]) => [org, h.instagram]).filter(([, v]) => v)
  );
  const allLiHandles: Record<string, string> = Object.fromEntries(
    Object.entries(orgHandleOverrides).map(([org, h]) => [org, h.linkedin]).filter(([, v]) => v)
  );

  function setHandle(org: string, platform: "twitter" | "instagram" | "youtube" | "linkedin", value: string) {
    setOrgHandleOverrides(prev => ({
      ...prev,
      [org]: { ...(prev[org] || { twitter: "", instagram: "", youtube: "", linkedin: "" }), [platform]: value },
    }));
  }

  const loadPrev = useCallback(async () => {
    try {
      const res = await fetch("/api/outputs", { credentials: "include" });
      const files: ReportFile[] = await res.json();
      setPrevReports(files.slice(0, 10));
    } catch {}
  }, []);

  useEffect(() => { loadPrev(); }, [loadPrev]);

  // Auto-save handles to localStorage whenever they change
  useEffect(() => {
    try { localStorage.setItem("emerald_handles", JSON.stringify(orgHandleOverrides)); } catch {}
  }, [orgHandleOverrides]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  function toggleOrg(org: string) {
    setSelectedOrgs((prev) => {
      if (prev.includes(org)) return prev.filter((o) => o !== org);
      return [...prev, org];
    });
  }

  function selectAllOrgs() {
    setSelectedOrgs([...allOrgs]);
  }

  function deselectAllOrgs() {
    setSelectedOrgs([]);
  }

  function addCustomOrg() {
    const val = orgCustomInput.trim();
    const handle = orgYtHandleInput.trim();
    if (!val || DEFAULT_ORGS.includes(val) || customOrgs.some(o => o.name === val)) {
      setOrgCustomInput(""); setOrgYtHandleInput(""); return;
    }
    setCustomOrgs((prev) => [...prev, { name: val, ytHandle: handle }]);
    setSelectedOrgs((prev) => [...prev, val]);
    setOrgHandleOverrides(prev => ({ ...prev, [val]: { twitter: "", instagram: "", youtube: handle, linkedin: "" } }));
    setOrgCustomInput(""); setOrgYtHandleInput("");
  }

  function addHandleOrg() {
    const val = hNewOrg.trim();
    if (!val) return;
    const alreadyExists = DEFAULT_ORGS.includes(val) || customOrgs.some(o => o.name === val);
    if (!alreadyExists) {
      setCustomOrgs(prev => [...prev, { name: val, ytHandle: hNewYt.trim() }]);
      setSelectedOrgs(prev => [...prev, val]);
    }
    setOrgHandleOverrides(prev => ({
      ...prev,
      [val]: {
        twitter:   hNewTw.trim().replace(/^@/, ""),
        instagram: hNewIg.trim().replace(/^@/, ""),
        youtube:   hNewYt.trim(),
        linkedin:  hNewLi.trim().replace(/^\/company\//i, ""),
      },
    }));
    setHNewOrg(""); setHNewTw(""); setHNewIg(""); setHNewYt(""); setHNewLi("");
  }

  function addScope() {
    const val = scopeInput.trim();
    if (!val || scopeKeywords.includes(val)) { setScopeInput(""); return; }
    withConfirm(`Add "${val}" to scope keywords?`, () => {
      setScopeKeywords((p) => [...p, val]);
      setScopeInput("");
    });
  }

  function removeScope(kw: string) {
    withConfirm(`Remove keyword "${kw}" from scope?`, () => setScopeKeywords((p) => p.filter((k) => k !== kw)));
  }

  function resetScope() {
    withConfirm("Reset scope keywords to defaults? All custom keywords will be removed.", () => setScopeKeywords([...DEFAULT_SCOPE]));
  }

  function addAeoQuery() {
    const val = aeoInput.trim();
    if (!val || aeoQueries.includes(val)) { setAeoInput(""); return; }
    withConfirm(`Add this query?\n\n"${val}"`, () => {
      setAeoQueries((p) => [...p, val]);
      setAeoInput("");
    });
  }

  function removeAeoQuery(idx: number) {
    withConfirm(`Remove Q${idx + 1}?\n\n"${aeoQueries[idx]}"`, () => setAeoQueries((p) => p.filter((_, i) => i !== idx)));
  }

  function resetAeoQueries() {
    withConfirm("Reset AEO queries to defaults? All custom queries will be removed.", () => setAeoQueries([...DEFAULT_AEO_QUERIES]));
  }

  function startEditAeo(idx: number) { setAeoEditIdx(idx); setAeoEditVal(aeoQueries[idx]); }
  function saveEditAeo() {
    if (aeoEditIdx === null) return;
    const val = aeoEditVal.trim();
    if (!val) { setAeoEditIdx(null); setAeoEditVal(""); return; }
    const original = aeoQueries[aeoEditIdx];
    if (val === original) { setAeoEditIdx(null); setAeoEditVal(""); return; }
    withConfirm(`Save changes to Q${aeoEditIdx + 1}?\n\nBefore: "${original}"\nAfter: "${val}"`, () => {
      setAeoQueries((p) => p.map((q, i) => (i === aeoEditIdx ? val : q)));
      setAeoEditIdx(null); setAeoEditVal("");
    });
  }

  async function downloadClientReport(htmlName: string) {
    try {
      const res = await fetch(`/api/download/${encodeURIComponent(htmlName)}`, { credentials: "include" });
      if (!res.ok) { alert("Could not fetch report."); return; }
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // Remove Action Matrix and Executive Summary from commercial version
      doc.getElementById("actions")?.remove();
      doc.getElementById("exec")?.remove();

      // Strip internal SENTINEL data-health notes
      doc.querySelectorAll(".sentinel-note").forEach((el) => el.remove());

      // Remove Executive Summary nav link
      const execNavLink = doc.querySelector('a[href="#exec"]');
      if (execNavLink) {
        const prev = execNavLink.previousElementSibling;
        const next = execNavLink.nextElementSibling;
        if (prev?.classList.contains("nav-lbl") && (!next || next.classList.contains("nav-lbl"))) {
          prev.remove();
        }
        execNavLink.remove();
      }

      // Renumber remaining section eyebrows sequentially
      doc.querySelectorAll(".se").forEach((el, idx) => {
        const num = String(idx + 1).padStart(2, "0");
        el.textContent = el.textContent!.replace(/^Section\s+\S+/, `Section ${num}`);
      });

      const clientHtml = "<!DOCTYPE html>" + doc.documentElement.outerHTML;
      const blob = new Blob([clientHtml], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = htmlName.replace(/\.html$/i, "-client.html");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert("Download failed.");
    }
  }

  async function startRun() {
    if (!selectedOrgs.length) { alert("Select at least one organisation."); return; }
    setRunning(true); setLogs([]); setProgress(0); setResult(null); setTrendStatus(null);

    const payload = { orgs: selectedOrgs, orgYtHandles: allOrgHandles, orgTwHandles: allTwHandles, orgIgHandles: allIgHandles, orgLiHandles: allLiHandles, dateFrom, dateTo, clientName, scopeKeywords, aeoQueries };
    const TOTAL_STEPS = 60;
    let stepCount = 0;

    // Track runId sent by the server so we can poll for the result if the
    // 5-min infrastructure proxy timeout kills the SSE connection mid-run.
    let runId: string | null = null;
    let gotDone = false;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!res.ok) { const err = await res.json(); alert("Error: " + (err.error || res.status)); setRunning(false); return; }

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const block of parts) {
          if (!block.trim() || block.startsWith(":")) continue; // skip heartbeat pings
          const lines = block.split("\n");
          let event = "message"; let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          let parsed: { msg?: string; level?: string; htmlName?: string; costInr?: number; runId?: string };
          try { parsed = JSON.parse(data); } catch { continue; }

          if (event === "runId") {
            runId = parsed.runId ?? null;
          } else if (event === "log") {
            const level = (parsed.level || "") as LogLevel;
            setLogs((prev) => [...prev, { msg: parsed.msg || "", level }]);
            stepCount = Math.min(stepCount + 1, TOTAL_STEPS - 1);
            setProgress(Math.round((stepCount / TOTAL_STEPS) * 100));
            if (parsed.msg?.includes("[TREND]")) {
              const m = parsed.msg.trim();
              if (m.includes("Spike detected")) {
                const match = m.match(/Spike detected: "([^"]+)"/);
                const topic = match ? match[1] : "trend";
                setTrendStatus({ text: `Last run: Trend detected — "${topic}"`, ok: true });
              } else if (m.includes("No spike detected")) {
                setTrendStatus({ text: "Last run: No trend spike detected", ok: false });
              }
            }
          } else if (event === "done") {
            gotDone = true;
            setProgress(100);
            setResult({ htmlName: parsed.htmlName!, costInr: parsed.costInr });
            await loadPrev();
          } else if (event === "error") {
            gotDone = true;
            setLogs((prev) => [...prev, { msg: "✗ Fatal error: " + parsed.msg, level: "err" }]);
          }
        }
      }
    } catch (e: unknown) {
      setLogs((prev) => [...prev, { msg: "✗ Connection dropped: " + (e as Error).message, level: "warn" }]);
    }

    // If the SSE stream closed without a `done` event (proxy timeout kills the
    // connection at ~5 min) but we have a runId, poll the status endpoint until
    // the pipeline finishes on the server.
    if (!gotDone && runId) {
      setLogs((prev) => [...prev, { msg: "⏳ Stream closed — pipeline still running on the server. Checking for the result every 15s (up to 45 min)…", level: "warn" }]);
      setProgress(95);
      const MAX_POLLS = 180; // 180 × 15s = 45 minutes
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, 15000));
        try {
          const sr = await fetch(`/api/run/status/${runId}`, { credentials: "include" });
          if (!sr.ok) continue;
          const s = await sr.json() as { status: string; htmlName?: string; costInr?: number; msg?: string };
          if (s.status === "done" && s.htmlName) {
            setProgress(100);
            setResult({ htmlName: s.htmlName, costInr: s.costInr });
            await loadPrev();
            setLogs((prev) => [...prev, { msg: `✓ Report recovered — ${s.htmlName}`, level: "ok" }]);
            break;
          } else if (s.status === "error") {
            setLogs((prev) => [...prev, { msg: `✗ Pipeline error: ${s.msg}`, level: "err" }]);
            break;
          } else {
            const mins = Math.round(((i + 1) * 15) / 60);
            setLogs((prev) => [...prev, { msg: `  Still running… (${mins} min elapsed since stream closed)`, level: "warn" }]);
          }
        } catch { /* network blip — retry */ }
      }
    }

    setRunning(false);
  }

  function logColor(level: LogLevel) {
    if (level === "head") return C.gold;
    if (level === "ok")   return C.green;
    if (level === "warn") return "#e8a020";
    if (level === "err")  return "#e05353";
    return C.muted;
  }

  return (
    <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", background: C.bg, minHeight: "100vh", color: C.text, position: "relative", overflowX: "hidden" }}>

      {/* ── Confirmation dialog ─────────────────────────────────────────── */}
      {confirmState && (
        <div
          onClick={() => setConfirmState(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(5px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 16px" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--elevate-2)", border: `1px solid ${C.border}`, borderRadius: 14, padding: "28px 28px 22px", maxWidth: 440, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", gap: 20 }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
              <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>⚠</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: C.gold, marginBottom: 8 }}>Confirm Change</div>
                <div style={{ fontSize: 15, color: C.text, lineHeight: 1.65, whiteSpace: "pre-wrap", fontFamily: "'DM Mono', monospace" }}>{confirmState.message}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmState(null)}
                style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}
              >Cancel</button>
              <button
                onClick={() => { confirmState.onConfirm(); setConfirmState(null); }}
                style={{ background: C.gold, color: "var(--bg-app)", border: "none", borderRadius: 8, padding: "8px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Animated background blobs */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>
        <div style={{
          position: "absolute", width: 600, height: 600, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(201,146,42,.1) 0%, transparent 70%)",
          filter: "blur(80px)", top: -150, left: -100,
          animation: "blob-drift-a 14s ease-in-out infinite alternate",
        }} />
        <div style={{
          position: "absolute", width: 500, height: 500, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(76,175,116,.07) 0%, transparent 70%)",
          filter: "blur(80px)", bottom: -80, right: -60,
          animation: "blob-drift-b 18s ease-in-out infinite alternate-reverse",
        }} />
      </div>

      {/* Keyframe animations injected globally */}
      <style>{`
        @keyframes blob-drift-a { from { transform: translate(0,0) scale(1); } to { transform: translate(50px,35px) scale(1.1); } }
        @keyframes blob-drift-b { from { transform: translate(0,0) scale(1); } to { transform: translate(-40px,-30px) scale(1.08); } }
        @keyframes ring-spin { to { transform: rotate(360deg); } }
        @keyframes shine-sweep { from { left: -60%; } to { left: 120%; } }
        @keyframes pulse-dot { 0%,100% { box-shadow: 0 0 0 0 rgba(76,175,116,.5); } 60% { box-shadow: 0 0 0 7px rgba(76,175,116,0); } }
        .mo-org-btn:hover { border-color: rgba(201,146,42,.3) !important; background: var(--elevate-2) !important; color: var(--text-main) !important; }
        .mo-org-btn:hover .mo-org-dot { background: rgba(201,146,42,.5) !important; }
        .mo-gen-btn:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(201,146,42,.45) !important; }
        .mo-gen-btn:not(:disabled):hover .mo-shine { animation: shine-sweep .6s ease forwards; }
        .mo-card:hover { border-color: rgba(201,146,42,.18) !important; }
        .mo-nav-link:hover { color: var(--accent-amber) !important; background: var(--elevate-2) !important; }
        .mo-icon-btn:hover { background: var(--elevate-2) !important; color: var(--text-main) !important; }
        .mo-stat:hover { transform: translateY(-3px); border-color: rgba(201,146,42,.2) !important; }
        .mo-collapse-btn:hover { color: var(--accent-amber) !important; }
        input[type=date] { color-scheme: light dark; }
        @keyframes quote-fade { 0%,100%{opacity:0;transform:translateY(10px)} 12%,88%{opacity:1;transform:translateY(0)} }
        @keyframes phase-pulse { 0%,100%{opacity:.45} 50%{opacity:1} }
        @keyframes loader-orbit { to{transform:rotate(360deg)} }
        @keyframes loader-inner { to{transform:rotate(-360deg)} }
      `}</style>

      {/* ── Sticky topbar ───────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        background: "color-mix(in srgb, var(--bg-app) 85%, transparent)", backdropFilter: "blur(16px)",
        borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 40px",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%",
            border: `2px solid ${C.gold}`,
            position: "relative", flexShrink: 0,
            animation: "ring-spin 8s linear infinite",
          }}>
            <div style={{
              position: "absolute", top: 4, left: 4, right: 4, bottom: 4,
              borderRadius: "50%", background: `rgba(201,146,42,.2)`,
            }} />
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.01em", color: C.goldLight }}>emerald</span>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
            background: "rgba(201,146,42,.18)", color: C.gold,
            padding: "2px 7px", borderRadius: 5,
          }}>AI</span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", gap: 4 }}>
          <a onClick={() => setActiveTab("dashboard")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 15, fontWeight: 500, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s", color: activeTab === "dashboard" ? C.goldLight : C.muted, background: activeTab === "dashboard" ? "var(--elevate-2)" : "transparent" }}>Dashboard</a>
          <a onClick={() => setActiveTab("reports")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 15, fontWeight: 500, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s", color: activeTab === "reports" ? C.goldLight : C.muted, background: activeTab === "reports" ? "var(--elevate-2)" : "transparent" }}>Reports</a>
          <a onClick={() => setActiveTab("handles")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 15, fontWeight: 500, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s", color: activeTab === "handles" ? C.goldLight : C.muted, background: activeTab === "handles" ? "var(--elevate-2)" : "transparent" }}>Handles</a>
          {user?.role === "admin" && (
            <a onClick={() => navigate("/admin")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 15, fontWeight: 500, color: C.muted, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s" }}>Admin</a>
          )}
        </nav>

        {/* Right */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={async () => { await logout(); navigate("/login"); }}
            className="mo-icon-btn"
            style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.muted, padding: "5px 12px", fontSize: 18, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", transition: "background .2s, color .2s" }}
          >Logout</button>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: "linear-gradient(135deg, var(--accent-amber) 0%, #6f4e10 100%)",
            color: "#fff", fontSize: 18, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            {user?.username ? user.username.slice(0, 2).toUpperCase() : "SA"}
          </div>
        </div>
      </header>

      {/* ── Page content ────────────────────────────────────────────────── */}
      <div style={{ padding: "0 40px 80px", position: "relative", zIndex: 1 }}>

        {activeTab === "dashboard" && (<div>

        {/* Hero */}
        <SlideUp delay={60} style={{ padding: "48px 0 8px" }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: C.gold, marginBottom: 14 }}>
            AQ Intelligence Platform
          </div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 46, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-.02em", margin: "0 0 8px", color: C.textHi }}>
            Air Quality<br />
            <span style={{
              background: "linear-gradient(90deg, var(--accent-amber) 0%, var(--accent-green) 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>Intelligence Report</span>
          </h1>
          <p style={{ fontSize: 18, color: C.muted, marginTop: 8 }}>
            Generate comparative air quality media intelligence reports with LLM visibility and social media analysis.
          </p>
        </SlideUp>

        {/* Stat bar */}
        <SlideUp delay={130}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "24px 0 0" }}>
            {[
              { label: "Orgs available",  val: allOrgs.length,       suffix: "" },
              { label: "Orgs selected",   val: orgCount,             suffix: `/ ${allOrgs.length}` },
              { label: "AEO queries",     val: aeoQueries.length,    suffix: "" },
              { label: "API keys active", val: 6,                    suffix: " / 6" },
            ].map((s) => (
              <div key={s.label} className="mo-stat" style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: "16px 18px",
                transition: "transform .2s, border-color .2s",
              }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 28, fontWeight: 500, color: C.gold, lineHeight: 1 }}>
                  <CountUp target={s.val} suffix={s.suffix} />
                </div>
                <div style={{ fontSize: 15, color: C.muted, marginTop: 6, fontWeight: 500 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </SlideUp>

        {/* API keys info */}
        <SlideUp delay={190}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, padding: "9px 16px", background: "rgba(76,175,116,.07)", border: "1px solid rgba(76,175,116,.2)", borderRadius: 100, width: "fit-content" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, animation: "pulse-dot 1.8s ease-in-out infinite", flexShrink: 0, display: "inline-block" }} />
            <span style={{ fontSize: 18, color: C.green }}>
              <strong>API keys pre-loaded</strong> — Serper, Claude, OpenAI, Perplexity, Gemini &amp; social keys are active
            </span>
          </div>
        </SlideUp>

        {/* ── Config grid ──────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 16, marginTop: 24, alignItems: "flex-start" }}>

          {/* Left — Org selector */}
          <SlideUp delay={240} style={{ flex: 2 }}>
            <div className="mo-card" style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 14, padding: "20px 22px",
              transition: "border-color .3s",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <SectionLabel>Organisations</SectionLabel>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={orgCount === allOrgs.length ? deselectAllOrgs : selectAllOrgs}
                    style={{
                      fontFamily: "'DM Mono', monospace", fontSize: 13,
                      padding: "3px 10px", borderRadius: 6, cursor: "pointer",
                      background: "rgba(76,175,116,.1)", color: "var(--accent-green)",
                      border: `1px solid rgba(76,175,116,.25)`,
                    }}
                  >
                    {orgCount === allOrgs.length ? "Deselect All" : "Select All"}
                  </button>
                  <span style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 15,
                    padding: "3px 10px", borderRadius: 6,
                    background: "rgba(201,146,42,.12)", color: C.gold,
                    border: `1px solid rgba(201,146,42,.2)`,
                  }}>
                    {orgCount} selected
                  </span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
                {allOrgs.map((org) => {
                  const on = selectedOrgs.includes(org);
                  const ov = orgHandleOverrides[org] || { twitter: "", instagram: "", youtube: "", linkedin: "" };
                  const chips: { label: string; val: string; color: string }[] = [
                    { label: "in", val: ov.linkedin  || "",                      color: "#0a8fd4" },
                    { label: "𝕏",  val: ov.twitter   ? `@${ov.twitter}`  : "", color: "#4a9fd4" },
                    { label: "IG", val: ov.instagram  ? `@${ov.instagram}` : "", color: "#e05c9c" },
                    { label: "YT", val: ov.youtube   || "",                      color: "#e53935" },
                  ].filter(c => c.val);
                  return (
                    <button
                      key={org}
                      className="mo-org-btn"
                      onClick={() => toggleOrg(org)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4,
                        padding: "9px 11px", borderRadius: 9, cursor: "pointer",
                        background: on ? "rgba(201,146,42,.1)" : "var(--elevate-1)",
                        border: `1px solid ${on ? "rgba(201,146,42,.3)" : "var(--border-col)"}`,
                        color: on ? C.gold : C.muted,
                        fontSize: 18, fontFamily: "'Space Grotesk', sans-serif",
                        textAlign: "left", transition: "all .2s",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="mo-org-dot" style={{
                          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                          background: on ? C.gold : "var(--text-muted)",
                          boxShadow: on ? `0 0 6px ${C.gold}` : "none",
                          transition: "background .2s, box-shadow .2s",
                        }} />
                        {org}
                      </span>
                      {chips.length > 0 && (
                        <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 6px", paddingLeft: 14 }}>
                          {chips.map(c => (
                            <span key={c.label} style={{
                              fontSize: 9, fontFamily: "'DM Mono', monospace",
                              color: on ? c.color : "rgba(74,96,112,.8)",
                              lineHeight: 1.3,
                            }}>
                              <span style={{ opacity: .5, marginRight: 2 }}>{c.label}</span>{c.val}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Custom org input */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={orgCustomInput}
                    onChange={(e) => setOrgCustomInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomOrg(); } }}
                    placeholder="Organisation name…"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <input
                    value={orgYtHandleInput}
                    onChange={(e) => setOrgYtHandleInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomOrg(); } }}
                    placeholder="@YouTubeHandle (optional)"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={addCustomOrg} style={{
                    background: "var(--elevate-2)", color: C.text, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 14px", fontSize: 18, cursor: "pointer",
                    fontFamily: "'Space Grotesk', sans-serif", whiteSpace: "nowrap",
                  }}>+ Add</button>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 5, fontFamily: "'DM Mono', monospace" }}>
                Each org adds ~5 Serper queries + ~2 Claude calls
              </div>
            </div>
          </SlideUp>

          {/* Right column */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Date range */}
            <SlideUp delay={290}>
              <Card>
                <SectionLabel>Date Range</SectionLabel>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>FROM</div>
                    <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} />
                  </div>
                  <span style={{ color: C.muted, fontSize: 18, paddingTop: 20 }}>→</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>TO</div>
                    <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} />
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>CLIENT NAME</div>
                  <input value={clientName} onChange={(e) => setClientName(e.target.value)} style={inputStyle} placeholder="Client name (appears in footer)" />
                </div>
              </Card>
            </SlideUp>

            {/* Scope keywords */}
            <SlideUp delay={330}>
              <Card>
                <button
                  onClick={() => setScopeOpen(!scopeOpen)}
                  className="mo-collapse-btn"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, color: C.gold, transition: "color .2s" }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase" }}>
                    Scope Keywords
                    <span style={{ marginLeft: 8, background: "var(--elevate-2)", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 600, verticalAlign: "middle", fontFamily: "'DM Mono', monospace" }}>optional</span>
                  </span>
                  <span style={{ fontSize: 15, color: C.muted }}>{scopeOpen ? "▲" : "▼"}</span>
                </button>
                {scopeOpen && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                      {scopeKeywords.map((kw) => (
                        <span key={kw} style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          background: "rgba(76,175,116,.08)", color: C.green,
                          border: "1px solid rgba(76,175,116,.2)", borderRadius: 100,
                          padding: "3px 10px", fontSize: 15, fontFamily: "'DM Mono', monospace",
                        }}>
                          {kw}
                          <span onClick={() => removeScope(kw)} style={{ cursor: "pointer", opacity: 0.6 }}>×</span>
                        </span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={scopeInput} onChange={(e) => setScopeInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScope(); } }} placeholder="Add keyword…" style={{ ...inputStyle, flex: 1, width: "auto" }} />
                      <button onClick={addScope} style={{ background: "var(--elevate-2)", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 15, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>+ Add</button>
                      <button onClick={resetScope} style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 15, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>Reset</button>
                    </div>
                  </div>
                )}
              </Card>
            </SlideUp>

            {/* AEO queries */}
            <SlideUp delay={370}>
              <Card>
                <button
                  onClick={() => setAeoOpen(!aeoOpen)}
                  className="mo-collapse-btn"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, color: C.gold, transition: "color .2s" }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase" }}>
                    AEO Discovery Queries
                    <span style={{ marginLeft: 8, background: "var(--elevate-2)", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 600, verticalAlign: "middle", fontFamily: "'DM Mono', monospace" }}>
                      {aeoQueries.length} queries
                    </span>
                  </span>
                  <span style={{ fontSize: 15, color: C.muted }}>{aeoOpen ? "▲" : "▼"}</span>
                </button>
                {aeoOpen && (
                  <div style={{ marginTop: 14 }}>
                    <p style={{ fontSize: 15, color: C.muted, marginBottom: 12, lineHeight: 1.7, fontFamily: "'DM Mono', monospace" }}>
                      Sent to GPT-4o mini, Perplexity Sonar &amp; Gemini 1.5 Flash. Each response naming a tracked org = <strong style={{ color: C.gold }}>10 pts</strong> (max 100). Click to edit inline.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, maxHeight: 300, overflowY: "auto" }}>
                      {aeoQueries.map((q, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: "var(--elevate-1)", border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px" }}>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.gold, paddingTop: 3, minWidth: 22, flexShrink: 0 }}>Q{i + 1}</span>
                          {aeoEditIdx === i ? (
                            <div style={{ flex: 1, display: "flex", gap: 5, alignItems: "flex-start" }}>
                              <textarea
                                autoFocus
                                value={aeoEditVal}
                                onChange={(e) => setAeoEditVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditAeo(); } if (e.key === "Escape") setAeoEditIdx(null); }}
                                style={{ flex: 1, background: "var(--elevate-1)", border: `1px solid ${C.gold}`, borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 15, fontFamily: "'DM Mono', monospace", outline: "none", resize: "vertical", minHeight: 40 }}
                              />
                              <button onClick={saveEditAeo} style={{ background: C.gold, color: C.bg, border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>✓</button>
                              <button onClick={() => setAeoEditIdx(null)} style={{ background: "var(--elevate-2)", color: C.muted, border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 10, cursor: "pointer" }}>✕</button>
                            </div>
                          ) : (
                            <>
                              <span onClick={() => startEditAeo(i)} style={{ flex: 1, fontSize: 15, color: C.muted, lineHeight: 1.55, cursor: "text", paddingTop: 2, fontFamily: "'DM Mono', monospace" }}>{q}</span>
                              <button onClick={() => removeAeoQuery(i)} style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px", opacity: 0.6 }}>×</button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={aeoInput} onChange={(e) => setAeoInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAeoQuery(); } }} placeholder="Add custom query…" style={{ ...inputStyle, flex: 1, width: "auto" }} />
                      <button onClick={addAeoQuery} style={{ background: "var(--elevate-2)", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 15, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>+ Add</button>
                      <button onClick={resetAeoQueries} style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 15, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>Reset</button>
                    </div>
                  </div>
                )}
              </Card>
            </SlideUp>
          </div>
        </div>

        {/* ── Social Handles ──────────────────────────────────────────── */}
        <SlideUp delay={400}>
          <Card style={{ marginTop: 16 }}>
            <button
              onClick={() => setHandlesOpen(!handlesOpen)}
              className="mo-collapse-btn"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, color: C.gold, transition: "color .2s" }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase" }}>
                Social Handles
                <span style={{ marginLeft: 8, background: "var(--elevate-2)", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 600, verticalAlign: "middle", fontFamily: "'DM Mono', monospace" }}>
                  LI · X · IG · YT per org
                </span>
              </span>
              <span style={{ fontSize: 11, color: C.muted }}>{handlesOpen ? "▲" : "▼"}</span>
            </button>
            {handlesOpen && (
              <div style={{ marginTop: 14, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: C.muted, padding: "0 10px 8px 0", whiteSpace: "nowrap" }}>Org</th>
                      <th style={{ textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#0a8fd4", padding: "0 10px 8px", whiteSpace: "nowrap" }}>LinkedIn</th>
                      <th style={{ textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#4a9fd4", padding: "0 10px 8px", whiteSpace: "nowrap" }}>𝕏 Twitter</th>
                      <th style={{ textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#e05c9c", padding: "0 10px 8px", whiteSpace: "nowrap" }}>Instagram</th>
                      <th style={{ textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#e53935", padding: "0 0 8px 10px", whiteSpace: "nowrap" }}>YouTube</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrgs.map((org, i) => {
                      const handles = orgHandleOverrides[org] || { twitter: "", instagram: "", youtube: "", linkedin: "" };
                      const rowBg = i % 2 === 0 ? "var(--elevate-1)" : "transparent";
                      const cellInput = (platform: "twitter" | "instagram" | "youtube" | "linkedin", color: string) => (
                        <input
                          value={handles[platform]}
                          onChange={e => setHandle(org, platform, e.target.value)}
                          placeholder="—"
                          style={{
                            background: "var(--elevate-1)",
                            border: `1px solid ${handles[platform] ? `${color}44` : "var(--border-col)"}`,
                            borderRadius: 6, padding: "5px 9px",
                            color: handles[platform] ? color : C.muted,
                            fontFamily: "'DM Mono', monospace", fontSize: 11,
                            outline: "none", width: "100%", minWidth: 120, boxSizing: "border-box",
                          }}
                        />
                      );
                      return (
                        <tr key={org} style={{ background: rowBg }}>
                          <td style={{ padding: "5px 10px 5px 0", fontFamily: "'Space Grotesk', sans-serif", fontSize: 11, color: C.text, whiteSpace: "nowrap", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {org.length > 30 ? org.slice(0, 28) + "…" : org}
                          </td>
                          <td style={{ padding: "5px 10px" }}>{cellInput("linkedin", "#0a8fd4")}</td>
                          <td style={{ padding: "5px 10px" }}>{cellInput("twitter", "#4a9fd4")}</td>
                          <td style={{ padding: "5px 10px" }}>{cellInput("instagram", "#e05c9c")}</td>
                          <td style={{ padding: "5px 0 5px 10px" }}>{cellInput("youtube", "#e53935")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: 10, fontFamily: "'DM Mono', monospace", fontSize: 9, color: "var(--text-muted)" }}>
                  Handles without @ · used by APIdirect.io for LinkedIn ER · X ER · Instagram ER · YouTube subscriber count
                </div>
              </div>
            )}
          </Card>
        </SlideUp>

        {/* ── Generate button ─────────────────────────────────────────── */}
        <SlideUp delay={430}>
          <button
            onClick={startRun}
            disabled={running}
            className="mo-gen-btn"
            style={{
              width: "100%", marginTop: 20,
              padding: "16px 0", borderRadius: 12,
              background: "linear-gradient(135deg, var(--accent-amber) 0%, #8b5e15 100%)",
              color: "#fff", fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 18, fontWeight: 600, letterSpacing: "-.01em",
              border: "none", cursor: running ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              position: "relative", overflow: "hidden",
              opacity: running ? 0.7 : 1,
              boxShadow: "0 4px 24px rgba(201,146,42,.35)",
              transition: "transform .2s, box-shadow .2s, opacity .2s",
            }}
          >
            <span className="mo-shine" style={{
              position: "absolute", top: 0, left: "-60%", width: "40%", height: "100%",
              background: "linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent)",
              transform: "skewX(-20deg)", pointerEvents: "none",
            }} />
            {running ? (
              <>
                <span style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,.3)", borderTopColor: "#fff", display: "inline-block", animation: "ring-spin .7s linear infinite" }} />
                Generating Report…
              </>
            ) : (
              <>▶&nbsp; Generate Report</>
            )}
          </button>
        </SlideUp>

        {/* Trend status */}
        {trendStatus && (
          <div style={{ marginTop: 10, fontFamily: "'DM Mono', monospace", fontSize: 15, padding: "7px 14px", background: "var(--elevate-1)", border: `1px solid ${trendStatus.ok ? "rgba(76,175,116,.3)" : C.border}`, borderRadius: 8, color: trendStatus.ok ? C.green : C.muted }}>
            {trendStatus.text}
          </div>
        )}

        {/* ── Progress + animated loading screen ─────────────────────── */}
        {running && (
          <div style={{ marginTop: 18 }}>
            {/* Progress bar */}
            <div style={{ height: 3, background: "var(--border-col)", borderRadius: 2, marginBottom: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg, var(--accent-amber), var(--accent-green))", borderRadius: 2, width: `${progress}%`, transition: "width .5s cubic-bezier(.22,1,.36,1)" }} />
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.gold, textAlign: "right", marginBottom: 10 }}>{progress}%</div>

            {/* Loading card */}
            <div style={{
              background: "var(--elevate-1)", border: `1px solid ${C.border}`,
              borderRadius: 16, padding: "44px 40px 36px",
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 28, minHeight: 260, position: "relative", overflow: "hidden",
            }}>
              {/* Subtle background glow */}
              <div style={{
                position: "absolute", width: 320, height: 320, borderRadius: "50%", pointerEvents: "none",
                background: "radial-gradient(circle, rgba(201,146,42,.06) 0%, transparent 70%)",
                filter: "blur(40px)", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
              }} />

              {/* Orbital loader */}
              <div style={{ position: "relative", width: 56, height: 56, flexShrink: 0 }}>
                <div style={{
                  position: "absolute", inset: 0, borderRadius: "50%",
                  border: "2px solid transparent",
                  borderTopColor: "var(--accent-amber)",
                  borderRightColor: "rgba(201,146,42,.3)",
                  animation: "loader-orbit 1.4s linear infinite",
                }} />
                <div style={{
                  position: "absolute", inset: 8, borderRadius: "50%",
                  border: "1.5px solid transparent",
                  borderTopColor: "var(--accent-green)",
                  borderLeftColor: "rgba(76,175,116,.3)",
                  animation: "loader-inner 1.8s linear infinite",
                }} />
                <div style={{
                  position: "absolute", inset: "50%", transform: "translate(-50%,-50%)",
                  width: 8, height: 8, borderRadius: "50%",
                  background: "var(--accent-amber)",
                  boxShadow: "0 0 10px var(--accent-amber)",
                }} />
              </div>

              {/* Phase label */}
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: 11,
                fontWeight: 600, letterSpacing: ".18em", textTransform: "uppercase",
                color: "var(--accent-amber)", opacity: 0.85,
                animation: "phase-pulse 2s ease-in-out infinite",
              }}>
                {detectPhase(logs)}
              </div>

              {/* Quote */}
              <div style={{
                textAlign: "center", maxWidth: 520,
                animation: "quote-fade 4.2s ease-in-out infinite",
              } as React.CSSProperties} key={quoteIdx}>
                <p style={{
                  fontSize: 20, fontWeight: 600, lineHeight: 1.5,
                  color: "var(--text-main)", margin: "0 0 10px",
                  fontFamily: "'Space Grotesk', sans-serif",
                  letterSpacing: "-.01em",
                }}>
                  "{LOADING_QUOTES[quoteIdx].text}"
                </p>
                <p style={{
                  fontSize: 12, color: "var(--text-muted)",
                  fontFamily: "'DM Mono', monospace",
                  margin: 0, letterSpacing: ".06em",
                }}>
                  — {LOADING_QUOTES[quoteIdx].author}
                </p>
              </div>

              {/* Dot trail */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {LOADING_QUOTES.map((_, i) => (
                  <div key={i} style={{
                    width: i === quoteIdx ? 18 : 5,
                    height: 4, borderRadius: 2,
                    background: i === quoteIdx ? "var(--accent-amber)" : "var(--border-col)",
                    transition: "all .4s cubic-bezier(.22,1,.36,1)",
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}
        {/* Hidden log ref for auto-scroll */}
        <div ref={logBoxRef} style={{ display: "none" }} />

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && (
          <div style={{ background: "rgba(76,175,116,.06)", border: "1px solid rgba(76,175,116,.25)", borderRadius: 12, padding: 20, marginTop: 18 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.green, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>✓ Report ready</span>
              {result.costInr != null && (
                <span style={{ fontSize: 18, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: C.gold }}>₹{result.costInr.toFixed(2)}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {/* Commercial report (strips Action Matrix) */}
              <button
                onClick={() => downloadClientReport(result.htmlName)}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: C.green, color: C.bg, fontFamily: "'Space Grotesk', sans-serif", border: "none" }}
              >⬇ Commercial</button>
              {/* Personal report (includes Action Matrix) */}
              <a
                href={`/api/download/${encodeURIComponent(result.htmlName)}`}
                download={result.htmlName}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: "rgba(76,175,116,.15)", color: C.green, border: `1px solid rgba(76,175,116,.35)`, fontFamily: "'Space Grotesk', sans-serif" }}
              >⬇ Personal</a>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, fontFamily: "'DM Mono', monospace" }}>
              Commercial excludes AI Executive Summary &amp; Action Matrix · Personal includes everything
            </div>
          </div>
        )}

        </div>)}

        {/* ── Reports tab ─────────────────────────────────────────────── */}
        {activeTab === "reports" && (
          <div style={{ paddingTop: 40 }}>
            <SlideUp delay={40}>
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: C.gold, marginBottom: 10 }}>
                  Reports
                </div>
                <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 36, fontWeight: 700, letterSpacing: "-.02em", color: C.textHi, margin: 0 }}>
                  Previous Reports
                </h2>
                <p style={{ fontSize: 15, color: C.muted, marginTop: 6 }}>
                  All generated reports, most recent first.
                </p>
              </div>
            </SlideUp>

            {prevReports.length === 0 ? (
              <SlideUp delay={80}>
                <div style={{
                  textAlign: "center", padding: "60px 0",
                  background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: 14,
                }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
                  <div style={{ fontSize: 18, color: C.muted }}>No reports yet — generate one from the Dashboard tab.</div>
                </div>
              </SlideUp>
            ) : (
              <SlideUp delay={80}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {prevReports.map((f, i) => (
                    <div key={f.name} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "14px 18px",
                      background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: 12, fontSize: 15,
                      transition: "border-color .2s",
                      animationDelay: `${i * 40}ms`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 28, flexShrink: 0 }}>📄</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: C.text, fontFamily: "'DM Mono', monospace", fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f.name}
                          </div>
                          <div style={{ color: C.muted, fontFamily: "'DM Mono', monospace", fontSize: 10, marginTop: 3 }}>
                            {f.size} KB · {f.mtime}{f.costInr ? <span style={{ color: C.gold }}> · ₹{parseFloat(f.costInr).toFixed(2)}</span> : null}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 16 }}>
                        {f.name.endsWith(".html") && (
                          <button
                            onClick={() => downloadClientReport(f.name)}
                            style={{
                              padding: "7px 14px", borderRadius: 8,
                              background: "rgba(76,175,116,.12)", color: C.green,
                              border: `1px solid rgba(76,175,116,.25)`,
                              fontSize: 18, fontWeight: 600, cursor: "pointer",
                              fontFamily: "'Space Grotesk', sans-serif",
                            }}
                          >⬇ Commercial</button>
                        )}
                        <a
                          href={`/api/download/${encodeURIComponent(f.name)}`}
                          download={f.name}
                          style={{
                            padding: "7px 14px", borderRadius: 8,
                            background: "rgba(201,146,42,.12)", color: C.gold,
                            border: `1px solid rgba(201,146,42,.25)`,
                            fontSize: 18, fontWeight: 600, textDecoration: "none",
                            fontFamily: "'Space Grotesk', sans-serif",
                          }}
                        >⬇ Personal</a>
                      </div>
                    </div>
                  ))}
                </div>
              </SlideUp>
            )}
          </div>
        )}

        {/* ── Handles tab ─────────────────────────────────────────────── */}
        {activeTab === "handles" && (
          <div style={{ paddingTop: 40 }}>
            <SlideUp delay={40}>
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: C.gold, marginBottom: 10 }}>
                  Social Handles
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                  <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 32, fontWeight: 700, letterSpacing: "-.02em", color: C.textHi, margin: 0 }}>
                    Organisation Handles
                  </h2>
                  <button
                    onClick={() => {
                      try { localStorage.setItem("emerald_handles", JSON.stringify(orgHandleOverrides)); } catch {}
                      setHandlesSaved(true);
                      setTimeout(() => setHandlesSaved(false), 2200);
                    }}
                    style={{
                      flexShrink: 0,
                      padding: "10px 22px", borderRadius: 9,
                      background: handlesSaved ? "rgba(76,175,116,.15)" : "rgba(201,146,42,.15)",
                      border: `1px solid ${handlesSaved ? "rgba(76,175,116,.4)" : "rgba(201,146,42,.35)"}`,
                      color: handlesSaved ? C.green : C.gold,
                      fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
                      cursor: "pointer", transition: "all .3s",
                    }}
                  >
                    {handlesSaved ? "✓ Saved" : "Save Handles"}
                  </button>
                </div>
                <p style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
                  Changes auto-save in your browser. Click Save Handles to confirm.
                </p>
              </div>
            </SlideUp>

            <SlideUp delay={80}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
                {/* Table header */}
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${C.border}` }}>
                  {[
                    { label: "Organisation", color: C.muted },
                    { label: "LinkedIn",     color: "#0a8fd4" },
                    { label: "𝕏 Twitter",   color: "#4a9fd4" },
                    { label: "Instagram",    color: "#e05c9c" },
                    { label: "YouTube",      color: "#e53935" },
                  ].map(col => (
                    <div key={col.label} style={{
                      padding: "12px 16px",
                      fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 700,
                      letterSpacing: ".15em", textTransform: "uppercase", color: col.color,
                    }}>{col.label}</div>
                  ))}
                </div>

                {/* Rows — all orgs */}
                {[...DEFAULT_ORGS, ...customOrgs.map(o => o.name)].map((org, i) => {
                  const ov = orgHandleOverrides[org] || { twitter: "", instagram: "", youtube: "", linkedin: "" };
                  const rowBg = i % 2 === 0 ? "transparent" : "var(--elevate-1)";
                  const cellSty: React.CSSProperties = {
                    background: "var(--elevate-1)",
                    border: `1px solid var(--border-col)`,
                    borderRadius: 6, padding: "6px 10px",
                    color: C.text,
                    fontFamily: "'DM Mono', monospace", fontSize: 12,
                    outline: "none", width: "100%", boxSizing: "border-box",
                    transition: "border-color .2s",
                  };
                  return (
                    <div key={org} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 0, background: rowBg, borderBottom: `1px solid var(--border-col)` }}>
                      {/* Org name */}
                      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontFamily: "'Space Grotesk', sans-serif", color: C.text }}>{org}</span>
                      </div>
                      {/* LinkedIn */}
                      <div style={{ padding: "10px 10px" }}>
                        <input
                          value={ov.linkedin}
                          onChange={e => setHandle(org, "linkedin", e.target.value)}
                          placeholder="company-slug"
                          style={{ ...cellSty, color: ov.linkedin ? "#0a8fd4" : C.muted, borderColor: ov.linkedin ? "rgba(10,143,212,.3)" : "var(--border-col)" }}
                        />
                      </div>
                      {/* Twitter */}
                      <div style={{ padding: "10px 10px" }}>
                        <input
                          value={ov.twitter}
                          onChange={e => setHandle(org, "twitter", e.target.value)}
                          placeholder="handle (no @)"
                          style={{ ...cellSty, color: ov.twitter ? "#4a9fd4" : C.muted, borderColor: ov.twitter ? "rgba(74,159,212,.3)" : "var(--border-col)" }}
                        />
                      </div>
                      {/* Instagram */}
                      <div style={{ padding: "10px 10px" }}>
                        <input
                          value={ov.instagram}
                          onChange={e => setHandle(org, "instagram", e.target.value)}
                          placeholder="handle (no @)"
                          style={{ ...cellSty, color: ov.instagram ? "#e05c9c" : C.muted, borderColor: ov.instagram ? "rgba(224,92,156,.3)" : "var(--border-col)" }}
                        />
                      </div>
                      {/* YouTube */}
                      <div style={{ padding: "10px 10px" }}>
                        <input
                          value={ov.youtube}
                          onChange={e => setHandle(org, "youtube", e.target.value)}
                          placeholder="@channel"
                          style={{ ...cellSty, color: ov.youtube ? "#e53935" : C.muted, borderColor: ov.youtube ? "rgba(229,57,53,.3)" : "var(--border-col)" }}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* Add new org row */}
                <div style={{ borderTop: `1px solid ${C.border}`, background: "rgba(201,146,42,.04)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 0 }}>
                    <div style={{ padding: "10px 10px" }}>
                      <input
                        value={hNewOrg}
                        onChange={e => setHNewOrg(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") addHandleOrg(); }}
                        placeholder="New organisation name…"
                        style={{
                          background: "rgba(201,146,42,.06)", border: `1px solid rgba(201,146,42,.2)`,
                          borderRadius: 6, padding: "6px 10px", color: C.goldLight,
                          fontFamily: "'Space Grotesk', sans-serif", fontSize: 12,
                          outline: "none", width: "100%", boxSizing: "border-box",
                        }}
                      />
                    </div>
                    <div style={{ padding: "10px 10px" }}>
                      <input value={hNewLi} onChange={e => setHNewLi(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addHandleOrg(); }} placeholder="company-slug" style={{ background: "rgba(10,143,212,.06)", border: "1px solid rgba(10,143,212,.2)", borderRadius: 6, padding: "6px 10px", color: "#0a8fd4", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ padding: "10px 10px" }}>
                      <input value={hNewTw} onChange={e => setHNewTw(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addHandleOrg(); }} placeholder="twitter_handle" style={{ background: "rgba(74,159,212,.06)", border: "1px solid rgba(74,159,212,.2)", borderRadius: 6, padding: "6px 10px", color: "#4a9fd4", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ padding: "10px 10px" }}>
                      <input value={hNewIg} onChange={e => setHNewIg(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addHandleOrg(); }} placeholder="instagram_handle" style={{ background: "rgba(224,92,156,.06)", border: "1px solid rgba(224,92,156,.2)", borderRadius: 6, padding: "6px 10px", color: "#e05c9c", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ padding: "10px 10px", display: "flex", gap: 6 }}>
                      <input value={hNewYt} onChange={e => setHNewYt(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addHandleOrg(); }} placeholder="@youtube_channel" style={{ background: "rgba(229,57,53,.06)", border: "1px solid rgba(229,57,53,.2)", borderRadius: 6, padding: "6px 10px", color: "#e53935", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", flex: 1, boxSizing: "border-box" }} />
                      <button
                        onClick={addHandleOrg}
                        style={{ background: "rgba(201,146,42,.18)", border: `1px solid rgba(201,146,42,.35)`, borderRadius: 6, color: C.gold, fontSize: 16, fontWeight: 700, cursor: "pointer", padding: "0 12px", flexShrink: 0 }}
                      >+</button>
                    </div>
                  </div>
                  <div style={{ padding: "0 16px 10px", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
                    Press Enter or + to add · new orgs also appear in the Dashboard org selector
                  </div>
                </div>
              </div>
            </SlideUp>
          </div>
        )}

      </div>
    </div>
  );
}
