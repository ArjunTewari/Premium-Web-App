import { useEffect, useRef, useState } from "react";
import "./motion.css";

const ORGS = [
  "CPCB", "IQAir", "Respirer Living Sciences", "UrbanEmissions",
  "CEEW", "Greenpeace India", "CSE India", "WHO India",
];

function SlideUp({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), delay); return () => clearTimeout(t); }, [delay]);
  return <div className={`su ${v ? "su-in" : ""} ${className}`}>{children}</div>;
}

function CountUp({ target, suffix = "" }: { target: number; suffix?: string }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = Math.ceil(target / 40);
    const iv = setInterval(() => {
      start = Math.min(start + step, target);
      setVal(start);
      if (start >= target) clearInterval(iv);
    }, 30);
    return () => clearInterval(iv);
  }, [target]);
  return <>{val.toLocaleString()}{suffix}</>;
}

export function Motion() {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["CPCB", "IQAir", "Respirer Living Sciences"])
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{ msg: string; level: string }[]>([]);
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
    setProgress(0);
    setLogs([]);
    const steps = [
      { msg: "Pipeline initialised", level: "head" },
      { msg: "STEP 1 — Serper search complete (42 articles)", level: "ok" },
      { msg: "STEP 2 — Claude analysis (sentiment + framing)", level: "head" },
      { msg: "  ✓ 38 articles scored", level: "ok" },
      { msg: "STEP 3 — AEO: LLM visibility mapped", level: "ok" },
      { msg: "  ⚠  Respirer partial data", level: "warn" },
      { msg: "STEP 4 — YouTube ER computed", level: "head" },
      { msg: "STEP 5 — Report assembled", level: "ok" },
      { msg: "Done. Download ready.", level: "ok" },
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
      }
    }, 380);
  };

  return (
    <div className="mo-root">
      {/* Animated gradient blob */}
      <div className="mo-blob blob-1" />
      <div className="mo-blob blob-2" />

      {/* Topbar */}
      <SlideUp delay={0}>
        <header className="mo-topbar">
          <div className="mo-logo">
            <div className="mo-logo-ring" />
            <span className="mo-logo-text">emerald</span>
            <span className="mo-logo-tag">AI</span>
          </div>
          <nav className="mo-nav">
            {["Dashboard", "Reports", "Admin"].map((l) => (
              <a key={l} href="#" className={`mo-nav-item ${l === "Dashboard" ? "active" : ""}`}>{l}</a>
            ))}
          </nav>
          <div className="mo-avatar">SA</div>
        </header>
      </SlideUp>

      {/* Hero */}
      <SlideUp delay={60}>
        <div className="mo-hero">
          <div className="mo-hero-label">AQ INTELLIGENCE PLATFORM</div>
          <h1 className="mo-hero-title">
            Air Quality<br />
            <span className="mo-gradient-text">Intelligence Report</span>
          </h1>
        </div>
      </SlideUp>

      {/* Stat bar */}
      <SlideUp delay={120}>
        <div className="mo-stats">
          {[
            { label: "Orgs tracked", val: 47, suffix: "" },
            { label: "Articles indexed", val: 12400, suffix: "+" },
            { label: "Reports generated", val: 284, suffix: "" },
            { label: "API keys active", val: 6, suffix: "/6" },
          ].map((s) => (
            <div key={s.label} className="mo-stat">
              <div className="mo-stat-val"><CountUp target={s.val} suffix={s.suffix} /></div>
              <div className="mo-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </SlideUp>

      {/* Config row */}
      <div className="mo-config-row">
        {/* Orgs */}
        <SlideUp delay={200} className="mo-card flex-2">
          <div className="mo-card-head">
            <span className="mo-card-title">Organisations</span>
            <span className="mo-chip">{selected.size} selected</span>
          </div>
          <div className="mo-org-grid">
            {ORGS.map((org) => (
              <button
                key={org}
                className={`mo-org-btn ${selected.has(org) ? "mo-org-active" : ""}`}
                onClick={() => toggle(org)}
              >
                <span className={`mo-org-dot ${selected.has(org) ? "dot-active" : ""}`} />
                {org}
              </button>
            ))}
          </div>
        </SlideUp>

        {/* Right column */}
        <div className="mo-right-col">
          <SlideUp delay={260} className="mo-card">
            <div className="mo-card-title" style={{ marginBottom: 14 }}>Date Range</div>
            <div className="mo-date-row">
              <div className="mo-date-field">
                <label className="mo-label">From</label>
                <input type="date" defaultValue="2025-01-01" className="mo-input" />
              </div>
              <div className="mo-date-sep">→</div>
              <div className="mo-date-field">
                <label className="mo-label">To</label>
                <input type="date" defaultValue="2025-06-30" className="mo-input" />
              </div>
            </div>
          </SlideUp>

          <SlideUp delay={310} className="mo-card">
            <div className="mo-card-title" style={{ marginBottom: 12 }}>Keywords</div>
            <div className="mo-chips-wrap">
              {["air quality", "AQI", "PM2.5", "NCAP", "pollution"].map((k) => (
                <span key={k} className="mo-kw-chip">{k}</span>
              ))}
              <button className="mo-kw-add">＋ Add</button>
            </div>
          </SlideUp>
        </div>
      </div>

      {/* Run button */}
      <SlideUp delay={370}>
        <button className={`mo-run-btn ${running ? "mo-running" : ""}`} onClick={simulate} disabled={running}>
          {running ? (
            <><span className="mo-spinner" /> Generating Report…</>
          ) : (
            <><span className="mo-btn-icon">▶</span> Generate Report</>
          )}
          <div className="mo-btn-shine" />
        </button>
      </SlideUp>

      {/* Progress */}
      {logs.length > 0 && (
        <SlideUp delay={0} className="mo-log-card">
          <div className="mo-progress-track">
            <div className="mo-progress-fill" style={{ width: `${progress}%` }} />
            <span className="mo-progress-label">{progress}%</span>
          </div>
          <div className="mo-log-scroll" ref={logRef}>
            {logs.map((l, i) => (
              <div key={i} className={`mo-log-entry mo-${l.level}`}>
                <span className="mo-log-arrow">›</span> {l.msg}
              </div>
            ))}
          </div>
        </SlideUp>
      )}
    </div>
  );
}
