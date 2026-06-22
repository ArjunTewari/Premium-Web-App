import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

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
  "WRI India":                                        "@WRIIndiaChannel",
  "Air Pollution Action Group":                       "@theconvergencefoundation",
  "Chintan Environmental Research and Action Group":  "@ChintanEnviroGroup",
  "IIT Kanpur":                                       "@iitkanpur",
  "CSTEP":                                            "@centerforstudyofsciencetec7663",
  "IIT Delhi":                                        "@IITDelhiOfficial",
  "Health Effects Institute":                         "@HEIresearch",
  "ICCT":                                             "@ICCT",
  "EPIC India":                                       "@epicindia.uchicago",
  "Council on Energy, Environment and Water":         "@CEEWIndia",
  "Centre for Science and Environment":               "@cse_india",
  "Climate Trends":                                   "@ClimateTrendsIN",
  "Sustainable Futures Collaborative":                "@SFC_India",
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
  bg:        "#060a10",
  surface:   "rgba(255,255,255,.035)",
  border:    "rgba(255,255,255,.07)",
  gold:      "#c9922a",
  goldLight: "#e8d5a0",
  green:     "#4caf74",
  muted:     "#4a6070",
  text:      "#c8d8e8",
  textHi:    "#e8f0f8",
};

/* ── Shared input style ──────────────────────────────────────────────────── */
const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,.05)",
  border: `1px solid rgba(255,255,255,.12)`,
  borderRadius: 8,
  padding: "8px 12px",
  color: C.text,
  fontFamily: "'DM Mono', monospace",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  colorScheme: "dark",
  transition: "border-color .2s",
};

export default function Home() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  const [selectedOrgs, setSelectedOrgs] = useState<string[]>(["Council on Energy, Environment and Water", "CSTEP"]);
  const [customOrgs, setCustomOrgs] = useState<{ name: string; ytHandle: string }[]>([]);
  const [orgCustomInput, setOrgCustomInput] = useState("");
  const [orgYtHandleInput, setOrgYtHandleInput] = useState("");

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

  const [activeTab, setActiveTab] = useState<"dashboard" | "reports">("dashboard");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [trendStatus, setTrendStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const [result, setResult] = useState<{ htmlName: string; pptxName: string } | null>(null);
  const [prevReports, setPrevReports] = useState<ReportFile[]>([]);

  const logBoxRef = useRef<HTMLDivElement>(null);

  const allOrgs = [...DEFAULT_ORGS, ...customOrgs.map(o => o.name)];
  const orgCount = selectedOrgs.length;

  const allOrgHandles: Record<string, string> = {
    ...ORG_YT_HANDLES,
    ...Object.fromEntries(customOrgs.map(o => [o.name, o.ytHandle])),
  };

  const loadPrev = useCallback(async () => {
    try {
      const res = await fetch("/api/outputs", { credentials: "include" });
      const files: ReportFile[] = await res.json();
      setPrevReports(files.slice(0, 10));
    } catch {}
  }, []);

  useEffect(() => { loadPrev(); }, [loadPrev]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  function toggleOrg(org: string) {
    setSelectedOrgs((prev) => {
      if (prev.includes(org)) return prev.filter((o) => o !== org);
      if (prev.length >= 13) return prev;
      return [...prev, org];
    });
  }

  function addCustomOrg() {
    const val = orgCustomInput.trim();
    const handle = orgYtHandleInput.trim();
    if (!val || DEFAULT_ORGS.includes(val) || customOrgs.some(o => o.name === val)) {
      setOrgCustomInput(""); setOrgYtHandleInput(""); return;
    }
    setCustomOrgs((prev) => [...prev, { name: val, ytHandle: handle }]);
    setSelectedOrgs((prev) => (prev.length < 13 ? [...prev, val] : prev));
    setOrgCustomInput(""); setOrgYtHandleInput("");
  }

  function addScope() {
    const val = scopeInput.trim();
    if (val && !scopeKeywords.includes(val)) setScopeKeywords((p) => [...p, val]);
    setScopeInput("");
  }

  function removeScope(kw: string) { setScopeKeywords((p) => p.filter((k) => k !== kw)); }

  function addAeoQuery() {
    const val = aeoInput.trim();
    if (val && !aeoQueries.includes(val)) setAeoQueries((p) => [...p, val]);
    setAeoInput("");
  }

  function removeAeoQuery(idx: number) { setAeoQueries((p) => p.filter((_, i) => i !== idx)); }
  function startEditAeo(idx: number) { setAeoEditIdx(idx); setAeoEditVal(aeoQueries[idx]); }
  function saveEditAeo() {
    if (aeoEditIdx === null) return;
    const val = aeoEditVal.trim();
    if (val) setAeoQueries((p) => p.map((q, i) => (i === aeoEditIdx ? val : q)));
    setAeoEditIdx(null); setAeoEditVal("");
  }

  async function downloadClientReport(htmlName: string) {
    try {
      const res = await fetch(`/api/download/${encodeURIComponent(htmlName)}`, { credentials: "include" });
      if (!res.ok) { alert("Could not fetch report."); return; }
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const actionsSection = doc.getElementById("actions") || doc.querySelector('[id*="action"]');
      if (actionsSection) actionsSection.remove();
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

    const payload = { orgs: selectedOrgs, orgYtHandles: allOrgHandles, dateFrom, dateTo, clientName, scopeKeywords, aeoQueries };
    const TOTAL_STEPS = 60;
    let stepCount = 0;

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
          if (!block.trim()) continue;
          const lines = block.split("\n");
          let event = "message"; let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          let parsed: { msg?: string; level?: string; htmlName?: string; pptxName?: string };
          try { parsed = JSON.parse(data); } catch { continue; }

          if (event === "log") {
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
            setProgress(100);
            setResult({ htmlName: parsed.htmlName!, pptxName: parsed.pptxName! });
            await loadPrev();
          } else if (event === "error") {
            setLogs((prev) => [...prev, { msg: "✗ Fatal error: " + parsed.msg, level: "err" }]);
          }
        }
      }
    } catch (e: unknown) {
      setLogs((prev) => [...prev, { msg: "✗ Connection error: " + (e as Error).message, level: "err" }]);
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

  const extIcon = (name: string) => (name.endsWith(".pptx") ? "📊" : "📄");

  /* ── Card wrapper ─────────────────────────────────────────────────────── */
  const Card = ({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) => (
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

  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", color: C.gold, marginBottom: 14 }}>
      {children}
    </div>
  );

  return (
    <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", background: C.bg, minHeight: "100vh", color: C.text, position: "relative", overflow: "hidden" }}>

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
        .mo-org-btn:hover { border-color: rgba(201,146,42,.3) !important; background: rgba(255,255,255,.06) !important; color: #c8d8e8 !important; }
        .mo-org-btn:hover .mo-org-dot { background: rgba(201,146,42,.5) !important; }
        .mo-gen-btn:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(201,146,42,.45) !important; }
        .mo-gen-btn:not(:disabled):hover .mo-shine { animation: shine-sweep .6s ease forwards; }
        .mo-card:hover { border-color: rgba(201,146,42,.18) !important; }
        .mo-nav-link:hover { color: #e8d5a0 !important; background: rgba(255,255,255,.06) !important; }
        .mo-icon-btn:hover { background: rgba(255,255,255,.06) !important; color: #c8d8e8 !important; }
        .mo-stat:hover { transform: translateY(-3px); border-color: rgba(201,146,42,.2) !important; }
        .mo-collapse-btn:hover { color: #c9922a !important; }
        input[type=date] { color-scheme: dark; }
      `}</style>

      {/* ── Sticky topbar ───────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        background: "rgba(6,10,16,.85)", backdropFilter: "blur(16px)",
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
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-.01em", color: C.goldLight }}>emerald</span>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
            background: "rgba(201,146,42,.18)", color: C.gold,
            padding: "2px 7px", borderRadius: 5,
          }}>AI</span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", gap: 4 }}>
          <a onClick={() => setActiveTab("dashboard")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s", color: activeTab === "dashboard" ? C.goldLight : C.muted, background: activeTab === "dashboard" ? "rgba(255,255,255,.06)" : "transparent" }}>Dashboard</a>
          <a onClick={() => setActiveTab("reports")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s", color: activeTab === "reports" ? C.goldLight : C.muted, background: activeTab === "reports" ? "rgba(255,255,255,.06)" : "transparent" }}>Reports</a>
          {user?.role === "admin" && (
            <a onClick={() => navigate("/admin")} className="mo-nav-link" style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, color: C.muted, textDecoration: "none", cursor: "pointer", transition: "color .2s, background .2s" }}>Admin</a>
          )}
        </nav>

        {/* Right */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={async () => { await logout(); navigate("/login"); }}
            className="mo-icon-btn"
            style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.muted, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", transition: "background .2s, color .2s" }}
          >Logout</button>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: "linear-gradient(135deg, #c9922a 0%, #6f4e10 100%)",
            color: "#fff", fontSize: 12, fontWeight: 700,
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
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: C.gold, marginBottom: 14 }}>
            AQ Intelligence Platform
          </div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 46, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-.02em", margin: "0 0 8px", color: C.textHi }}>
            Air Quality<br />
            <span style={{
              background: "linear-gradient(90deg, #c9922a 0%, #4caf74 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>Intelligence Report</span>
          </h1>
          <p style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
            Generate comparative air quality media intelligence reports with LLM visibility and social media analysis.
          </p>
        </SlideUp>

        {/* Stat bar */}
        <SlideUp delay={130}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "24px 0 0" }}>
            {[
              { label: "Orgs available",  val: allOrgs.length,       suffix: "" },
              { label: "Orgs selected",   val: orgCount,             suffix: `/ 13` },
              { label: "AEO queries",     val: aeoQueries.length,    suffix: "" },
              { label: "API keys active", val: 6,                    suffix: " / 6" },
            ].map((s) => (
              <div key={s.label} className="mo-stat" style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: "16px 18px",
                transition: "transform .2s, border-color .2s",
              }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 26, fontWeight: 500, color: C.gold, lineHeight: 1 }}>
                  <CountUp target={s.val} suffix={s.suffix} />
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6, fontWeight: 500 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </SlideUp>

        {/* API keys info */}
        <SlideUp delay={190}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, padding: "9px 16px", background: "rgba(76,175,116,.07)", border: "1px solid rgba(76,175,116,.2)", borderRadius: 100, width: "fit-content" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, animation: "pulse-dot 1.8s ease-in-out infinite", flexShrink: 0, display: "inline-block" }} />
            <span style={{ fontSize: 12, color: C.green }}>
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
                <span style={{
                  fontFamily: "'DM Mono', monospace", fontSize: 11,
                  padding: "3px 10px", borderRadius: 6,
                  background: "rgba(201,146,42,.12)", color: C.gold,
                  border: `1px solid rgba(201,146,42,.2)`,
                }}>
                  {orgCount}{orgCount >= 13 ? " — max" : ""} selected
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
                {allOrgs.map((org) => {
                  const on = selectedOrgs.includes(org);
                  const handle = allOrgHandles[org];
                  return (
                    <button
                      key={org}
                      className="mo-org-btn"
                      onClick={() => toggleOrg(org)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                        padding: "9px 11px", borderRadius: 9, cursor: "pointer",
                        background: on ? "rgba(201,146,42,.1)" : "rgba(255,255,255,.03)",
                        border: `1px solid ${on ? "rgba(201,146,42,.3)" : "rgba(255,255,255,.08)"}`,
                        color: on ? C.gold : C.muted,
                        fontSize: 12, fontFamily: "'Space Grotesk', sans-serif",
                        textAlign: "left", transition: "all .2s",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="mo-org-dot" style={{
                          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                          background: on ? C.gold : "#2a3a4a",
                          boxShadow: on ? `0 0 6px ${C.gold}` : "none",
                          transition: "background .2s, box-shadow .2s",
                        }} />
                        {org}
                      </span>
                      {handle && (
                        <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: on ? "rgba(201,146,42,.55)" : "rgba(74,96,112,.7)", paddingLeft: 14 }}>
                          {handle}
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
                    background: "rgba(255,255,255,.07)", color: C.text, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 14px", fontSize: 12, cursor: "pointer",
                    fontFamily: "'Space Grotesk', sans-serif", whiteSpace: "nowrap",
                  }}>+ Add</button>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#2a3a4a", marginTop: 5, fontFamily: "'DM Mono', monospace" }}>
                Select up to 13 · each org adds ~5 Serper queries + ~2 Claude calls
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
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "#2a3a4a", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>FROM</div>
                    <input type="text" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="YYYY-MM-DD" style={inputStyle} />
                  </div>
                  <span style={{ color: C.muted, fontSize: 16, paddingTop: 20 }}>→</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "#2a3a4a", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>TO</div>
                    <input type="text" value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="YYYY-MM-DD" style={inputStyle} />
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "#2a3a4a", marginBottom: 5, fontFamily: "'DM Mono', monospace" }}>CLIENT NAME</div>
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
                    <span style={{ marginLeft: 8, background: "rgba(255,255,255,.06)", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 600, verticalAlign: "middle", fontFamily: "'DM Mono', monospace" }}>optional</span>
                  </span>
                  <span style={{ fontSize: 11, color: C.muted }}>{scopeOpen ? "▲" : "▼"}</span>
                </button>
                {scopeOpen && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                      {scopeKeywords.map((kw) => (
                        <span key={kw} style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          background: "rgba(76,175,116,.08)", color: C.green,
                          border: "1px solid rgba(76,175,116,.2)", borderRadius: 100,
                          padding: "3px 10px", fontSize: 11, fontFamily: "'DM Mono', monospace",
                        }}>
                          {kw}
                          <span onClick={() => removeScope(kw)} style={{ cursor: "pointer", opacity: 0.6 }}>×</span>
                        </span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={scopeInput} onChange={(e) => setScopeInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScope(); } }} placeholder="Add keyword…" style={{ ...inputStyle, flex: 1, width: "auto" }} />
                      <button onClick={addScope} style={{ background: "rgba(255,255,255,.06)", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>+ Add</button>
                      <button onClick={() => setScopeKeywords([...DEFAULT_SCOPE])} style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>Reset</button>
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
                    <span style={{ marginLeft: 8, background: "rgba(255,255,255,.06)", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 600, verticalAlign: "middle", fontFamily: "'DM Mono', monospace" }}>
                      {aeoQueries.length} queries
                    </span>
                  </span>
                  <span style={{ fontSize: 11, color: C.muted }}>{aeoOpen ? "▲" : "▼"}</span>
                </button>
                {aeoOpen && (
                  <div style={{ marginTop: 14 }}>
                    <p style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.7, fontFamily: "'DM Mono', monospace" }}>
                      Sent to GPT-4o mini, Perplexity Sonar &amp; Gemini 1.5 Flash. Each response naming a tracked org = <strong style={{ color: C.gold }}>10 pts</strong> (max 100). Click to edit inline.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, maxHeight: 300, overflowY: "auto" }}>
                      {aeoQueries.map((q, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: "rgba(255,255,255,.03)", border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px" }}>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.gold, paddingTop: 3, minWidth: 22, flexShrink: 0 }}>Q{i + 1}</span>
                          {aeoEditIdx === i ? (
                            <div style={{ flex: 1, display: "flex", gap: 5, alignItems: "flex-start" }}>
                              <textarea
                                autoFocus
                                value={aeoEditVal}
                                onChange={(e) => setAeoEditVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditAeo(); } if (e.key === "Escape") setAeoEditIdx(null); }}
                                style={{ flex: 1, background: "rgba(255,255,255,.04)", border: `1px solid ${C.gold}`, borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 11, fontFamily: "'DM Mono', monospace", outline: "none", resize: "vertical", minHeight: 40 }}
                              />
                              <button onClick={saveEditAeo} style={{ background: C.gold, color: C.bg, border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>✓</button>
                              <button onClick={() => setAeoEditIdx(null)} style={{ background: "rgba(255,255,255,.07)", color: C.muted, border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 10, cursor: "pointer" }}>✕</button>
                            </div>
                          ) : (
                            <>
                              <span onClick={() => startEditAeo(i)} style={{ flex: 1, fontSize: 11, color: C.muted, lineHeight: 1.55, cursor: "text", paddingTop: 2, fontFamily: "'DM Mono', monospace" }}>{q}</span>
                              <button onClick={() => removeAeoQuery(i)} style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", opacity: 0.6 }}>×</button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={aeoInput} onChange={(e) => setAeoInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAeoQuery(); } }} placeholder="Add custom query…" style={{ ...inputStyle, flex: 1, width: "auto" }} />
                      <button onClick={addAeoQuery} style={{ background: "rgba(255,255,255,.06)", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>+ Add</button>
                      <button onClick={() => setAeoQueries([...DEFAULT_AEO_QUERIES])} style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>Reset</button>
                    </div>
                  </div>
                )}
              </Card>
            </SlideUp>
          </div>
        </div>

        {/* ── Generate button ─────────────────────────────────────────── */}
        <SlideUp delay={430}>
          <button
            onClick={startRun}
            disabled={running}
            className="mo-gen-btn"
            style={{
              width: "100%", marginTop: 20,
              padding: "16px 0", borderRadius: 12,
              background: "linear-gradient(135deg, #c9922a 0%, #8b5e15 100%)",
              color: "#fff", fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 16, fontWeight: 600, letterSpacing: "-.01em",
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
          <div style={{ marginTop: 10, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "7px 14px", background: "rgba(255,255,255,.03)", border: `1px solid ${trendStatus.ok ? "rgba(76,175,116,.3)" : C.border}`, borderRadius: 8, color: trendStatus.ok ? C.green : C.muted }}>
            {trendStatus.text}
          </div>
        )}

        {/* ── Progress + logs ─────────────────────────────────────────── */}
        {(running || logs.length > 0) && (
          <div style={{ marginTop: 18 }}>
            {/* Progress bar */}
            <div style={{ height: 3, background: "rgba(255,255,255,.08)", borderRadius: 2, marginBottom: 4, overflow: "hidden", position: "relative" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg, #c9922a, #4caf74)", borderRadius: 2, width: `${progress}%`, transition: "width .5s cubic-bezier(.22,1,.36,1)" }} />
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.gold, textAlign: "right", marginBottom: 10 }}>{progress}%</div>
            {/* Log box */}
            <div
              ref={logBoxRef}
              style={{
                background: "rgba(255,255,255,.025)", border: `1px solid ${C.border}`,
                borderRadius: 12, padding: "14px 18px",
                maxHeight: 300, overflowY: "auto",
                fontFamily: "'DM Mono', monospace", fontSize: 11, lineHeight: 1.9,
                display: "flex", flexDirection: "column", gap: 2,
              }}
            >
              {logs.map((l, i) => (
                <div key={i} style={{ color: logColor(l.level), display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ color: "rgba(201,146,42,.4)", flexShrink: 0 }}>›</span>
                  {l.msg}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && (
          <div style={{ background: "rgba(76,175,116,.06)", border: "1px solid rgba(76,175,116,.25)", borderRadius: 12, padding: 20, marginTop: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.green, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>✓ Report ready</span>
              <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: C.gold }}>~₹52 ± 3</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {/* Shareable report (strips Action Matrix) */}
              <button
                onClick={() => downloadClientReport(result.htmlName)}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: C.green, color: C.bg, fontFamily: "'Space Grotesk', sans-serif", border: "none" }}
              >⬇ Shareable Report</button>
              {/* Full report (includes Action Matrix) */}
              <a
                href={`/api/download/${encodeURIComponent(result.htmlName)}`}
                download={result.htmlName}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: "rgba(76,175,116,.15)", color: C.green, border: `1px solid rgba(76,175,116,.35)`, fontFamily: "'Space Grotesk', sans-serif" }}
              >⬇ Full Report</a>
              {/* PowerPoint */}
              <a
                href={`/api/download/${encodeURIComponent(result.pptxName)}`}
                download={result.pptxName}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: C.gold, color: C.bg, fontFamily: "'Space Grotesk', sans-serif" }}
              >⬇ PowerPoint</a>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, fontFamily: "'DM Mono', monospace" }}>
              Shareable Report excludes Action Matrix · Full Report includes everything
            </div>
          </div>
        )}

        </div>)}

        {/* ── Reports tab ─────────────────────────────────────────────── */}
        {activeTab === "reports" && (
          <div style={{ paddingTop: 40 }}>
            <SlideUp delay={40}>
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: C.gold, marginBottom: 10 }}>
                  Reports
                </div>
                <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 32, fontWeight: 700, letterSpacing: "-.02em", color: C.textHi, margin: 0 }}>
                  Previous Reports
                </h2>
                <p style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
                  All generated HTML and PowerPoint reports, most recent first.
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
                  <div style={{ fontSize: 14, color: C.muted }}>No reports yet — generate one from the Dashboard tab.</div>
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
                      borderRadius: 12, fontSize: 13,
                      transition: "border-color .2s",
                      animationDelay: `${i * 40}ms`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 20, flexShrink: 0 }}>{extIcon(f.name)}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: C.text, fontFamily: "'DM Mono', monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f.name}
                          </div>
                          <div style={{ color: C.muted, fontFamily: "'DM Mono', monospace", fontSize: 10, marginTop: 3 }}>
                            {f.size} KB · {f.mtime}
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
                              fontSize: 12, fontWeight: 600, cursor: "pointer",
                              fontFamily: "'Space Grotesk', sans-serif",
                            }}
                          >⬇ Shareable</button>
                        )}
                        <a
                          href={`/api/download/${encodeURIComponent(f.name)}`}
                          download={f.name}
                          style={{
                            padding: "7px 14px", borderRadius: 8,
                            background: "rgba(201,146,42,.12)", color: C.gold,
                            border: `1px solid rgba(201,146,42,.25)`,
                            fontSize: 12, fontWeight: 600, textDecoration: "none",
                            fontFamily: "'Space Grotesk', sans-serif",
                          }}
                        >{f.name.endsWith(".html") ? "⬇ Full" : "⬇ Download"}</a>
                      </div>
                    </div>
                  ))}
                </div>
              </SlideUp>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
