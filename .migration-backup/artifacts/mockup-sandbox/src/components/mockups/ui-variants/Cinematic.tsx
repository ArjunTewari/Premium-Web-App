import { useEffect, useRef, useState } from "react";
import "./cinematic.css";

const ORGS = [
  "CPCB", "IQAir", "Respirer Living Sciences", "UrbanEmissions",
  "CEEW", "Greenpeace India", "CSE India", "WHO India",
];

function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), delay); return () => clearTimeout(t); }, [delay]);
  return <div className={`reveal ${v ? "revealed" : ""} ${className}`}>{children}</div>;
}

export function Cinematic() {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["CPCB", "IQAir", "Respirer Living Sciences"])
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{ msg: string; level: string }[]>([]);
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const toggle = (org: string) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(org) ? n.delete(org) : n.add(org);
      return n;
    });

  const simulate = () => {
    if (running) return;
    setRunning(true);
    setDone(false);
    setProgress(0);
    setLogs([]);
    const steps = [
      { msg: "[ INIT ] Pipeline booting…", level: "head" },
      { msg: "[ SERPER ] Crawling 12 orgs × 3 queries", level: "head" },
      { msg: "[ SERPER ] 42 articles harvested", level: "ok" },
      { msg: "[ CLAUDE ] Sentiment + framing analysis", level: "head" },
      { msg: "[ CLAUDE ] 38 articles processed", level: "ok" },
      { msg: "[ AEO ] LLM visibility mapped", level: "ok" },
      { msg: "[ YOUTUBE ] ER computed for 9 channels", level: "ok" },
      { msg: "[ RENDER ] Building HTML report…", level: "head" },
      { msg: "[ DONE ] Report ready for download", level: "ok" },
    ];
    let i = 0;
    const iv = setInterval(() => {
      if (i < steps.length) {
        setLogs((p) => [...p, steps[i]]);
        setProgress(Math.round(((i + 1) / steps.length) * 100));
        i++;
        setTimeout(() => logRef.current?.scrollTo({ top: 9999, behavior: "smooth" }), 50);
      } else {
        clearInterval(iv);
        setRunning(false);
        setDone(true);
      }
    }, 400);
  };

  return (
    <div className="cin-root">
      {/* Scanline overlay */}
      <div className="cin-scanlines" />
      {/* Corner accents */}
      <div className="cin-corner cin-tl" />
      <div className="cin-corner cin-tr" />

      {/* Header */}
      <Reveal delay={0}>
        <header className="cin-header">
          <div className="cin-brand">
            <span className="cin-brand-bracket">[</span>
            <span className="cin-brand-em">EMERALD</span>
            <span className="cin-brand-bracket">]</span>
            <span className="cin-brand-ai">_AI</span>
          </div>
          <div className="cin-header-right">
            <div className="cin-status-indicator">
              <span className="cin-status-dot" />
              <span className="cin-status-text">SYS ONLINE</span>
            </div>
            <nav className="cin-nav">
              {["DASH", "REPORTS", "ADMIN"].map((l) => (
                <a key={l} href="#" className={`cin-nav-item ${l === "DASH" ? "cin-active" : ""}`}>{l}</a>
              ))}
            </nav>
            <div className="cin-user">SA</div>
          </div>
        </header>
      </Reveal>

      {/* Title block */}
      <Reveal delay={80}>
        <div className="cin-title-block">
          <div className="cin-eyebrow">AQ INTELLIGENCE PLATFORM // v2.4.1</div>
          <h1 className="cin-main-title">
            <span className="cin-title-line">GENERATE</span>
            <span className="cin-title-line cin-title-accent">REPORT</span>
          </h1>
          <div className="cin-divider-line" />
        </div>
      </Reveal>

      {/* Panel grid */}
      <div className="cin-panels">
        {/* Org selector */}
        <Reveal delay={160} className="cin-panel cin-panel-wide">
          <div className="cin-panel-label">ORGANISATIONS // {selected.size} ACTIVE</div>
          <div className="cin-org-grid">
            {ORGS.map((org, idx) => (
              <button
                key={org}
                className={`cin-org-item ${selected.has(org) ? "cin-org-on" : ""}`}
                onClick={() => toggle(org)}
                style={{ animationDelay: `${idx * 40}ms` }}
              >
                <span className="cin-org-index">{String(idx + 1).padStart(2, "0")}</span>
                <span className="cin-org-name">{org}</span>
                <span className={`cin-org-status ${selected.has(org) ? "on" : "off"}`}>
                  {selected.has(org) ? "●" : "○"}
                </span>
              </button>
            ))}
          </div>
        </Reveal>

        {/* Right panels */}
        <div className="cin-panel-stack">
          <Reveal delay={220} className="cin-panel">
            <div className="cin-panel-label">DATE RANGE</div>
            <div className="cin-date-row">
              <div className="cin-date-group">
                <span className="cin-date-label">FROM</span>
                <input type="date" defaultValue="2025-01-01" className="cin-date-input" />
              </div>
              <span className="cin-date-sep">//</span>
              <div className="cin-date-group">
                <span className="cin-date-label">TO</span>
                <input type="date" defaultValue="2025-06-30" className="cin-date-input" />
              </div>
            </div>
          </Reveal>

          <Reveal delay={280} className="cin-panel">
            <div className="cin-panel-label">SCOPE KEYWORDS</div>
            <div className="cin-kw-list">
              {["air quality", "AQI", "PM2.5", "NCAP", "air pollution"].map((k) => (
                <span key={k} className="cin-kw-tag">
                  <span className="cin-kw-hash">#</span>{k}
                </span>
              ))}
              <button className="cin-kw-add">+ ADD</button>
            </div>
          </Reveal>

          <Reveal delay={340} className="cin-panel cin-metrics-panel">
            <div className="cin-panel-label">SYSTEM METRICS</div>
            <div className="cin-metrics">
              {[
                { k: "SERPER", v: "READY" },
                { k: "CLAUDE", v: "READY" },
                { k: "YOUTUBE", v: "READY" },
                { k: "PERPLEXITY", v: "STANDBY" },
              ].map((m) => (
                <div key={m.k} className="cin-metric-row">
                  <span className="cin-metric-key">{m.k}</span>
                  <span className={`cin-metric-val ${m.v === "READY" ? "ready" : "standby"}`}>{m.v}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </div>

      {/* Execute button */}
      <Reveal delay={420}>
        <button className={`cin-execute-btn ${running ? "cin-executing" : ""} ${done ? "cin-done" : ""}`} onClick={simulate} disabled={running}>
          <span className="cin-btn-border" />
          <span className="cin-btn-content">
            {running ? (
              <><span className="cin-btn-spinner" /> EXECUTING PIPELINE…</>
            ) : done ? (
              <>✓ REPORT COMPLETE — DOWNLOAD</>
            ) : (
              <>EXECUTE // GENERATE REPORT</>
            )}
          </span>
        </button>
      </Reveal>

      {/* Terminal log */}
      {logs.length > 0 && (
        <Reveal delay={0} className="cin-terminal">
          <div className="cin-terminal-header">
            <span className="cin-terminal-title">PIPELINE TERMINAL</span>
            <div className="cin-terminal-progress">
              <div className="cin-term-bar">
                <div className="cin-term-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="cin-term-pct">{progress}%</span>
            </div>
          </div>
          <div className="cin-terminal-body" ref={logRef}>
            {logs.map((l, i) => (
              <div key={i} className={`cin-log cin-log-${l.level}`}>
                <span className="cin-cursor">▌</span>
                {l.msg}
              </div>
            ))}
            {running && <span className="cin-blink">█</span>}
          </div>
        </Reveal>
      )}
    </div>
  );
}
