import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

const DEFAULT_ORGS = [
  "CEEW", "CSTEP", "TERI", "CSE", "WRI India", "Greenpeace India",
  "Climate Trends", "iForest", "Urban Emissions", "CREA", "ATREE",
  "Respirer Living Sciences", "CLEAN",
];

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

export default function Home() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  const [selectedOrgs, setSelectedOrgs] = useState<string[]>(["CEEW", "CSTEP"]);
  const [customOrgs, setCustomOrgs] = useState<string[]>([]);
  const [orgCustomInput, setOrgCustomInput] = useState("");

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

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [trendStatus, setTrendStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const [result, setResult] = useState<{ htmlName: string; pptxName: string } | null>(null);
  const [prevReports, setPrevReports] = useState<ReportFile[]>([]);

  const logBoxRef = useRef<HTMLDivElement>(null);

  const allOrgs = [...DEFAULT_ORGS, ...customOrgs];
  const orgCount = selectedOrgs.length;

  const loadPrev = useCallback(async () => {
    try {
      const res = await fetch("/api/outputs", { credentials: "include" });
      const files: ReportFile[] = await res.json();
      setPrevReports(files.slice(0, 10));
    } catch {}
  }, []);

  useEffect(() => {
    loadPrev();
  }, [loadPrev]);

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
    if (!val || DEFAULT_ORGS.includes(val) || customOrgs.includes(val)) {
      setOrgCustomInput("");
      return;
    }
    setCustomOrgs((prev) => [...prev, val]);
    setSelectedOrgs((prev) => (prev.length < 13 ? [...prev, val] : prev));
    setOrgCustomInput("");
  }

  function addScope() {
    const val = scopeInput.trim();
    if (val && !scopeKeywords.includes(val)) {
      setScopeKeywords((prev) => [...prev, val]);
    }
    setScopeInput("");
  }

  function removeScope(kw: string) {
    setScopeKeywords((prev) => prev.filter((k) => k !== kw));
  }

  function addAeoQuery() {
    const val = aeoInput.trim();
    if (val && !aeoQueries.includes(val)) {
      setAeoQueries((prev) => [...prev, val]);
    }
    setAeoInput("");
  }

  function removeAeoQuery(idx: number) {
    setAeoQueries((prev) => prev.filter((_, i) => i !== idx));
  }

  function startEditAeo(idx: number) {
    setAeoEditIdx(idx);
    setAeoEditVal(aeoQueries[idx]);
  }

  function saveEditAeo() {
    if (aeoEditIdx === null) return;
    const val = aeoEditVal.trim();
    if (val) {
      setAeoQueries((prev) => prev.map((q, i) => (i === aeoEditIdx ? val : q)));
    }
    setAeoEditIdx(null);
    setAeoEditVal("");
  }

  async function startRun() {
    if (!selectedOrgs.length) {
      alert("Select at least one organisation.");
      return;
    }
    setRunning(true);
    setLogs([]);
    setProgress(0);
    setResult(null);
    setTrendStatus(null);

    const payload = {
      orgs: selectedOrgs,
      dateFrom,
      dateTo,
      clientName,
      scopeKeywords,
      aeoQueries,
    };

    const TOTAL_STEPS = 60;
    let stepCount = 0;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        alert("Error: " + (err.error || res.status));
        setRunning(false);
        return;
      }

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
          let event = "message";
          let data = "";
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

            if (parsed.msg && parsed.msg.includes("[TREND]")) {
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

  function logClass(level: LogLevel) {
    if (level === "head") return "text-amber-500 font-bold";
    if (level === "ok") return "text-green-400";
    if (level === "warn") return "text-yellow-400";
    if (level === "err") return "text-red-400";
    return "text-slate-400";
  }

  const extIcon = (name: string) => (name.endsWith(".pptx") ? "📊" : "📄");

  return (
    <div
      className="min-h-screen"
      style={{ background: "#0a0e17", color: "#d8e4f0", fontFamily: "'Inter', system-ui, sans-serif", fontSize: "14px", lineHeight: "1.6" }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px 80px" }}>
        {/* Header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#c9922a" }}>
              Emerald AI
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {user?.role === "admin" && (
                <button
                  onClick={() => navigate("/admin")}
                  style={{ background: "transparent", border: "1px solid #252d40", borderRadius: 5, color: "#8fa3b8", padding: "4px 10px", fontSize: 11, cursor: "pointer" }}
                >
                  Admin Panel
                </button>
              )}
              <button
                onClick={async () => { await logout(); navigate("/login"); }}
                style={{ background: "transparent", border: "1px solid #252d40", borderRadius: 5, color: "#8fa3b8", padding: "4px 10px", fontSize: 11, cursor: "pointer" }}
              >
                Logout
              </button>
            </div>
          </div>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28, fontWeight: 400, color: "#d8e4f0", marginBottom: 6 }}>
            AQ Intelligence Platform
          </h1>
          <p style={{ fontSize: 13, color: "#8fa3b8" }}>
            Generate comparative air quality media intelligence reports with LLM visibility and social media analysis.
          </p>
        </div>

        {/* Info box */}
        <div style={{ background: "rgba(76,175,116,.07)", border: "1px solid rgba(76,175,116,.25)", borderRadius: 6, padding: "10px 14px", fontSize: 11, color: "#8fa3b8", marginBottom: 16, lineHeight: 1.7 }}>
          <strong style={{ color: "#4caf74" }}>API keys are pre-loaded from server secrets.</strong> Serper, Claude, OpenAI, Perplexity, Gemini, and social media keys are configured server-side and applied automatically on every run.
        </div>

        {/* Report settings */}
        <div style={{ background: "#111520", border: "1px solid #252d40", borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#c9922a", marginBottom: 14 }}>
            Report settings
          </div>

          {/* Org selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 11, color: "#8fa3b8", marginBottom: 4 }}>
              Organisations{" "}
              <span style={{ color: orgCount >= 13 ? "#d4a017" : "#c9922a", fontFamily: "monospace" }}>
                ({orgCount} selected{orgCount >= 13 ? " — max" : ""})
              </span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "5px 12px", background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "10px 12px", maxHeight: 200, overflowY: "auto" }}>
              {allOrgs.map((org) => (
                <label key={org} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#d8e4f0", cursor: "pointer", padding: "2px 0" }}>
                  <input
                    type="checkbox"
                    checked={selectedOrgs.includes(org)}
                    onChange={() => toggleOrg(org)}
                    style={{ accentColor: "#c9922a", width: 13, height: 13, cursor: "pointer" }}
                  />
                  {org}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 7, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input
                value={orgCustomInput}
                onChange={(e) => setOrgCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomOrg(); } }}
                placeholder="Add custom org name..."
                style={{ flex: 1, minWidth: 160, background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "6px 9px", color: "#d8e4f0", fontSize: 11, fontFamily: "monospace", outline: "none" }}
              />
              <button
                onClick={addCustomOrg}
                style={{ background: "#252d40", color: "#8fa3b8", border: "none", borderRadius: 5, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}
              >+ Add</button>
            </div>
            <div style={{ fontSize: 10, color: "#5e7494", marginTop: 3 }}>
              Select up to 13. Each org adds ~5 Serper queries + ~2 Claude API calls.
            </div>
          </div>

          {/* Date + client row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, color: "#8fa3b8", marginBottom: 4 }}>Date From</label>
              <input
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                placeholder="YYYY-MM-DD"
                style={{ width: "100%", background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "8px 10px", color: "#d8e4f0", fontSize: 12, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, color: "#8fa3b8", marginBottom: 4 }}>Date To</label>
              <input
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                placeholder="YYYY-MM-DD"
                style={{ width: "100%", background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "8px 10px", color: "#d8e4f0", fontSize: 12, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, color: "#8fa3b8", marginBottom: 4 }}>Client Name (appears in footer)</label>
              <input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                style={{ width: "100%", background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "8px 10px", color: "#d8e4f0", fontSize: 12, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
              />
            </div>
          </div>
        </div>

        {/* Scope Keywords */}
        <div style={{ background: "#111520", border: "1px solid #252d40", borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <div
            onClick={() => setScopeOpen(!scopeOpen)}
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#c9922a", marginBottom: scopeOpen ? 14 : 0, display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}
          >
            Scope Keywords{" "}
            <span style={{ background: "#181e2e", color: "#8fa3b8", border: "1px solid #252d40", borderRadius: 3, padding: "1px 7px", fontSize: 9, fontWeight: 600 }}>optional</span>
            <span style={{ marginLeft: "auto", fontSize: 10 }}>{scopeOpen ? "▲ hide" : "▼ show"}</span>
          </div>
          {scopeOpen && (
            <div>
              <div style={{ fontSize: 10, color: "#5e7494", marginBottom: 10 }}>
                Keywords that must appear in articles for them to be counted as AQ coverage.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {scopeKeywords.map((kw) => (
                  <span
                    key={kw}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(201,146,42,.12)", color: "#c9922a", border: "1px solid rgba(201,146,42,.3)", borderRadius: 4, padding: "3px 8px", fontSize: 11, fontFamily: "monospace" }}
                  >
                    {kw}
                    <span onClick={() => removeScope(kw)} style={{ cursor: "pointer", opacity: 0.6, marginLeft: 2 }}>×</span>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={scopeInput}
                  onChange={(e) => setScopeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScope(); } }}
                  placeholder="Add keyword..."
                  style={{ flex: 1, background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "6px 9px", color: "#d8e4f0", fontSize: 11, fontFamily: "monospace", outline: "none" }}
                />
                <button onClick={addScope} style={{ background: "#252d40", color: "#8fa3b8", border: "none", borderRadius: 5, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>+ Add</button>
                <button onClick={() => setScopeKeywords([...DEFAULT_SCOPE])} style={{ background: "#252d40", color: "#5e7494", border: "none", borderRadius: 5, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>Reset</button>
              </div>
            </div>
          )}
        </div>

        {/* AEO Queries */}
        <div style={{ background: "#111520", border: "1px solid #252d40", borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <div
            onClick={() => setAeoOpen(!aeoOpen)}
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#c9922a", marginBottom: aeoOpen ? 14 : 0, display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}
          >
            AEO Discovery Queries{" "}
            <span style={{ background: "#181e2e", color: "#8fa3b8", border: "1px solid #252d40", borderRadius: 3, padding: "1px 7px", fontSize: 9, fontWeight: 600 }}>{aeoQueries.length} queries</span>
            <span style={{ marginLeft: "auto", fontSize: 10 }}>{aeoOpen ? "▲ hide" : "▼ show"}</span>
          </div>
          {aeoOpen && (
            <div>
              <div style={{ fontSize: 10, color: "#5e7494", marginBottom: 12, lineHeight: 1.7 }}>
                These questions are sent verbatim to GPT-4o mini, Perplexity Sonar, and Gemini 1.5 Flash.
                Each response that names a tracked org = <strong style={{ color: "#c9922a" }}>10 points</strong> (max 100).
                Click any query to edit it inline.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12, maxHeight: 360, overflowY: "auto" }}>
                {aeoQueries.map((q, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "6px 10px" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: "#c9922a", paddingTop: 3, minWidth: 22, flexShrink: 0 }}>Q{i + 1}</span>
                    {aeoEditIdx === i ? (
                      <div style={{ flex: 1, display: "flex", gap: 5, alignItems: "flex-start" }}>
                        <textarea
                          autoFocus
                          value={aeoEditVal}
                          onChange={(e) => setAeoEditVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditAeo(); } if (e.key === "Escape") { setAeoEditIdx(null); } }}
                          style={{ flex: 1, background: "#111520", border: "1px solid #c9922a", borderRadius: 4, padding: "4px 7px", color: "#d8e4f0", fontSize: 11, fontFamily: "monospace", outline: "none", resize: "vertical", minHeight: 40 }}
                        />
                        <button onClick={saveEditAeo} style={{ background: "#c9922a", color: "#0a0e17", border: "none", borderRadius: 4, padding: "4px 9px", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>✓</button>
                        <button onClick={() => setAeoEditIdx(null)} style={{ background: "#252d40", color: "#8fa3b8", border: "none", borderRadius: 4, padding: "4px 9px", fontSize: 10, cursor: "pointer", flexShrink: 0 }}>✕</button>
                      </div>
                    ) : (
                      <>
                        <span
                          onClick={() => startEditAeo(i)}
                          style={{ flex: 1, fontSize: 11, color: "#8fa3b8", lineHeight: 1.55, cursor: "text", paddingTop: 2 }}
                        >{q}</span>
                        <button onClick={() => removeAeoQuery(i)} style={{ background: "transparent", border: "none", color: "#5e7494", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0, opacity: 0.7 }}>×</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={aeoInput}
                  onChange={(e) => setAeoInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAeoQuery(); } }}
                  placeholder="Add custom query..."
                  style={{ flex: 1, background: "#181e2e", border: "1px solid #252d40", borderRadius: 5, padding: "6px 9px", color: "#d8e4f0", fontSize: 11, fontFamily: "monospace", outline: "none" }}
                />
                <button onClick={addAeoQuery} style={{ background: "#252d40", color: "#8fa3b8", border: "none", borderRadius: 5, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>+ Add</button>
                <button onClick={() => setAeoQueries([...DEFAULT_AEO_QUERIES])} style={{ background: "#252d40", color: "#5e7494", border: "none", borderRadius: 5, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>Reset</button>
              </div>
            </div>
          )}
        </div>

        {/* Run button */}
        <button
          onClick={startRun}
          disabled={running}
          style={{ width: "100%", background: "#c9922a", color: "#0a0e17", border: "none", borderRadius: 7, padding: 13, fontSize: 14, fontWeight: 700, cursor: running ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, margin: "20px 0 0", opacity: running ? 0.5 : 1 }}
        >
          <span>{running ? "⟳" : "▶"}</span>
          <span>{running ? "Running..." : "Generate Report"}</span>
        </button>

        {/* Trend status */}
        {trendStatus && (
          <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 11, padding: "6px 12px", background: "#181e2e", border: `1px solid ${trendStatus.ok ? "rgba(76,175,116,.3)" : "#252d40"}`, borderRadius: 4, color: trendStatus.ok ? "#4caf74" : "#8fa3b8", lineHeight: 1.6 }}>
            {trendStatus.text}
          </div>
        )}

        {/* Progress + logs */}
        {(running || logs.length > 0) && (
          <div style={{ marginTop: 16 }}>
            <div style={{ height: 3, background: "#252d40", borderRadius: 2, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ height: "100%", background: "#c9922a", borderRadius: 2, width: `${progress}%`, transition: "width .5s" }} />
            </div>
            <div
              ref={logBoxRef}
              style={{ background: "#181e2e", border: "1px solid #252d40", borderRadius: 7, padding: "14px 16px", maxHeight: 320, overflowY: "auto", fontFamily: "monospace", fontSize: 11, color: "#5e7494", lineHeight: 1.9 }}
            >
              {logs.map((l, i) => (
                <div key={i} className={logClass(l.level)}>{l.msg}</div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div style={{ background: "#111520", border: "1px solid #4caf74", borderRadius: 8, padding: 20, marginTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#4caf74", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
              ✓ Report ready
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a
                href={`/api/download/${encodeURIComponent(result.htmlName)}`}
                download={result.htmlName}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: "#4caf74", color: "#0a0e17" }}
              >
                ⬇ Download HTML Report
              </a>
              <a
                href={`/api/download/${encodeURIComponent(result.pptxName)}`}
                download={result.pptxName}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", background: "#c9922a", color: "#0a0e17" }}
              >
                ⬇ Download PowerPoint
              </a>
            </div>
          </div>
        )}

        {/* Previous reports */}
        {prevReports.length > 0 && (
          <div style={{ background: "#111520", border: "1px solid #252d40", borderRadius: 8, padding: 20, marginTop: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#5e7494", marginBottom: 12 }}>
              Previous reports
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {prevReports.map((f) => (
                <div key={f.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "#181e2e", borderRadius: 5, fontSize: 12 }}>
                  <span style={{ color: "#d8e4f0", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {extIcon(f.name)} {f.name}
                  </span>
                  <span style={{ color: "#5e7494", fontFamily: "monospace", fontSize: 10, margin: "0 10px", flexShrink: 0 }}>
                    {f.size}KB · {f.mtime}
                  </span>
                  <a
                    href={`/api/download/${encodeURIComponent(f.name)}`}
                    download={f.name}
                    style={{ color: "#c9922a", fontSize: 11, textDecoration: "none", flexShrink: 0, marginLeft: 6 }}
                  >
                    download
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
