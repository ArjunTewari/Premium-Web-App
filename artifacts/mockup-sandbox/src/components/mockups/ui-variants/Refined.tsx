import { useEffect, useState } from "react";
import "./refined.css";

const ORGS = [
  "CPCB", "IQAir", "Respirer Living Sciences", "UrbanEmissions", "CEEW",
  "Greenpeace India", "CSE India", "WHO India",
];

function FadeIn({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div className={`fade-in-block ${visible ? "is-visible" : ""} ${className}`}>
      {children}
    </div>
  );
}

export function Refined() {
  const [checked, setChecked] = useState<Record<string, boolean>>({
    CPCB: true, IQAir: true, "Respirer Living Sciences": true,
  });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{ msg: string; level: string }[]>([]);

  const toggle = (org: string) =>
    setChecked((p) => ({ ...p, [org]: !p[org] }));

  const simulate = () => {
    if (running) return;
    setRunning(true);
    setProgress(0);
    setLogs([]);
    const steps = [
      { msg: "Initialising pipeline…", level: "head" },
      { msg: "STEP 1 — Serper search (12 orgs × 3 queries)", level: "head" },
      { msg: "  ✓ CPCB — 9 articles found", level: "ok" },
      { msg: "  ✓ IQAir — 11 articles found", level: "ok" },
      { msg: "STEP 2 — Claude sentiment analysis", level: "head" },
      { msg: "  ✓ Sentiment scored for 38 articles", level: "ok" },
      { msg: "STEP 3 — AEO discovery (LLM visibility)", level: "head" },
      { msg: "  ⚠  Respirer — partial data", level: "warn" },
      { msg: "Report generation complete.", level: "ok" },
    ];
    let i = 0;
    const iv = setInterval(() => {
      if (i < steps.length) {
        setLogs((p) => [...p, steps[i]]);
        setProgress(Math.round(((i + 1) / steps.length) * 100));
        i++;
      } else {
        clearInterval(iv);
        setRunning(false);
      }
    }, 420);
  };

  return (
    <div className="refined-root">
      {/* Header */}
      <FadeIn delay={0}>
        <header className="refined-header">
          <div className="refined-brand">
            <div className="refined-brand-dot" />
            <span className="refined-brand-name">Emerald AI</span>
          </div>
          <nav className="refined-nav">
            <a href="#" className="refined-nav-link active">Dashboard</a>
            <a href="#" className="refined-nav-link">Reports</a>
            <a href="#" className="refined-nav-link">Admin</a>
          </nav>
          <button className="refined-avatar">SA</button>
        </header>
      </FadeIn>

      {/* Hero */}
      <FadeIn delay={80}>
        <div className="refined-hero">
          <p className="refined-overline">AQ Intelligence Platform</p>
          <h1 className="refined-title">Generate Report</h1>
          <p className="refined-subtitle">
            Surface air quality narratives across media, social &amp; LLMs.
          </p>
        </div>
      </FadeIn>

      {/* Status pill */}
      <FadeIn delay={160}>
        <div className="refined-status-pill">
          <span className="refined-dot-green pulse" />
          <span>All API keys configured — ready to run</span>
        </div>
      </FadeIn>

      {/* Main grid */}
      <div className="refined-grid">
        {/* Organisations */}
        <FadeIn delay={220} className="refined-card span-2">
          <div className="refined-card-header">
            <h2 className="refined-card-title">Organisations</h2>
            <span className="refined-badge">{Object.values(checked).filter(Boolean).length} selected</span>
          </div>
          <div className="refined-org-grid">
            {ORGS.map((org) => (
              <label key={org} className={`refined-org-item ${checked[org] ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={!!checked[org]}
                  onChange={() => toggle(org)}
                  className="refined-checkbox"
                />
                <span>{org}</span>
              </label>
            ))}
          </div>
        </FadeIn>

        {/* Date range */}
        <FadeIn delay={280} className="refined-card">
          <h2 className="refined-card-title">Date Range</h2>
          <div className="refined-field">
            <label className="refined-label">From</label>
            <input type="date" defaultValue="2025-01-01" className="refined-input" />
          </div>
          <div className="refined-field" style={{ marginTop: 14 }}>
            <label className="refined-label">To</label>
            <input type="date" defaultValue="2025-06-30" className="refined-input" />
          </div>
        </FadeIn>

        {/* Scope keywords */}
        <FadeIn delay={340} className="refined-card">
          <h2 className="refined-card-title">Scope Keywords</h2>
          <div className="refined-tags">
            {["air quality", "AQI", "PM2.5", "NCAP", "air pollution"].map((t) => (
              <span key={t} className="refined-tag">{t}</span>
            ))}
            <button className="refined-tag-add">+ Add</button>
          </div>
        </FadeIn>

        {/* Generate button */}
        <FadeIn delay={400} className="span-full">
          <button className={`refined-generate-btn ${running ? "loading" : ""}`} onClick={simulate} disabled={running}>
            {running ? (
              <>
                <span className="refined-spinner" />
                Running Pipeline…
              </>
            ) : (
              "Generate Report"
            )}
          </button>
        </FadeIn>

        {/* Progress + logs */}
        {logs.length > 0 && (
          <FadeIn delay={0} className="refined-card span-full">
            <div className="refined-progress-bar">
              <div className="refined-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="refined-log-box">
              {logs.map((l, i) => (
                <div key={i} className={`refined-log-line level-${l.level}`}>
                  {l.msg}
                </div>
              ))}
            </div>
          </FadeIn>
        )}
      </div>
    </div>
  );
}
