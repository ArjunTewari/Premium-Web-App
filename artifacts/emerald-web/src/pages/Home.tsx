import { useEffect, useRef, useState, useCallback } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────
const DEFAULT_ORGS = [
  'WRI India',
  'Air Pollution Action Group',
  'Chintan Environmental Research and Action Group',
  'IIT Kanpur',
  'CSTEP',
  'IIT Delhi',
  'Health Effects Institute',
  'ICCT',
  'EPIC India',
  'Council on Energy, Environment and Water',
  'Centre for Science and Environment',
  'Climate Trends',
  'Sustainable Futures Collaborative',
];

const ORG_YT_HANDLES: Record<string, string> = {
  'WRI India':                                        'UCYoSZhQQR6Pc9lFJjR5e18g',
  'Air Pollution Action Group':                       '',
  'Chintan Environmental Research and Action Group':  'UCg-HN_sFTRBNDDOWxEt138g',
  'IIT Kanpur':                                       'UCIdajcgyfqnD9PwDnv_xqmg',
  'CSTEP':                                            '',
  'IIT Delhi':                                        'UCJX9RwRoVAEFLWlhrNF3Lqg',
  'Health Effects Institute':                         'UCPli-nivc67QzWoW1nRumIw',
  'ICCT':                                             'UCjbSjAMN6yiGhczNwSgTJ6Q',
  'EPIC India':                                       'UCz-PtdD6pJSITzGt7q9gN8A',
  'Council on Energy, Environment and Water':         'UCNF-vGnm1jdA_jhrIpk84Tg',
  'Centre for Science and Environment':               'UCPUL9ZjjcobQ6XlgTo6Mr2g',
  'Climate Trends':                                   'UCed9gfyM-3SAGIAYpvSz8ig',
  'Sustainable Futures Collaborative':                'UCZcWNjwTwQK48D7z8oWAKCA',
};

const DEFAULT_SCOPE = [
  'AQI','PM2.5','PM10','air pollution','air quality','smog','clean air',
  'NCAP','GRAP','Black Carbon','Ozone','Ammonia','Carbon Monoxide',
  'Nitrogen Dioxide','Methane',
];

interface CustomOrg { name: string; ytHandle: string; }
interface LogLine { msg: string; level: string; }
interface ReportFile { name: string; size: number; mtime: string; }
interface RunResult { htmlName: string; pptxName: string; }

// ── Particle canvas ───────────────────────────────────────────────────────
function useParticleCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0, H = 0;
    interface Pt { x: number; y: number; r: number; vx: number; vy: number; a: number; }
    let pts: Pt[] = [];
    let rafId: number;

    function resize() {
      W = canvas!.width = window.innerWidth;
      H = canvas!.height = window.innerHeight;
    }
    function mkPt(): Pt {
      return {
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 1.4 + .3,
        vx: (Math.random() - .5) * .16,
        vy: (Math.random() - .5) * .16,
        a: Math.random() * .45 + .1,
      };
    }
    function init() { resize(); pts = Array.from({ length: 55 }, mkPt); }
    function draw() {
      ctx!.clearRect(0, 0, W, H);
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 120) {
            ctx!.globalAlpha = (.12 * (1 - d / 120)) * .55;
            ctx!.strokeStyle = '#c9922a';
            ctx!.lineWidth = .4;
            ctx!.beginPath();
            ctx!.moveTo(pts[i].x, pts[i].y);
            ctx!.lineTo(pts[j].x, pts[j].y);
            ctx!.stroke();
          }
        }
      }
      for (const p of pts) {
        ctx!.globalAlpha = p.a * .45;
        ctx!.fillStyle = '#c9922a';
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }
    function tick() {
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      }
      draw();
      rafId = requestAnimationFrame(tick);
    }
    window.addEventListener('resize', resize);
    init();
    tick();
    return () => { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); };
  }, [canvasRef]);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s: string) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Main component ─────────────────────────────────────────────────────────
export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const frameRef  = useRef<HTMLIFrameElement>(null);

  useParticleCanvas(canvasRef);

  // Org state
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([
    'Council on Energy, Environment and Water', 'CSTEP',
  ]);
  const [customOrgs, setCustomOrgs]   = useState<CustomOrg[]>([]);
  const [orgCustomName, setOrgCustomName]   = useState('');
  const [orgYtHandle, setOrgYtHandle]       = useState('');

  // Form state
  const [dateFrom, setDateFrom]     = useState('2026-03-08');
  const [dateTo, setDateTo]         = useState('2026-06-08');
  const [clientName, setClientName] = useState('Chetan Bhattacharji');

  // Scope keywords
  const [scopeKeywords, setScopeKeywords] = useState<string[]>([...DEFAULT_SCOPE]);
  const [scopeOpen, setScopeOpen]         = useState(false);
  const [scopeInput, setScopeInput]       = useState('');

  // Run state
  const [isRunning, setIsRunning]     = useState(false);
  const [logs, setLogs]               = useState<LogLine[]>([]);
  const [progress, setProgress]       = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [result, setResult]           = useState<RunResult | null>(null);
  const [trendStatus, setTrendStatus] = useState<{ msg: string; good: boolean } | null>(null);
  const stepsRef = useRef(0);

  // Previous reports
  const [prevReports, setPrevReports] = useState<ReportFile[]>([]);

  // Preview panel
  const [previewFile, setPreviewFile]         = useState('');
  const [previewOpen, setPreviewOpen]         = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [editMode, setEditMode]               = useState(false);
  const [dlMenuOpen, setDlMenuOpen]           = useState(false);

  // ── Org helpers ──────────────────────────────────────────────────────────
  const allOrgs = [
    ...DEFAULT_ORGS.map(name => ({ name, ytHandle: ORG_YT_HANDLES[name] || '' })),
    ...customOrgs,
  ];

  function toggleOrg(name: string) {
    setSelectedOrgs(prev => {
      if (prev.includes(name)) return prev.filter(o => o !== name);
      if (prev.length >= 13) return prev;
      return [...prev, name];
    });
  }

  function addCustomOrg() {
    const name = orgCustomName.trim();
    if (!name) return;
    const exists = DEFAULT_ORGS.includes(name) || customOrgs.some(o => o.name === name);
    if (exists) { setOrgCustomName(''); setOrgYtHandle(''); return; }
    setCustomOrgs(prev => [...prev, { name, ytHandle: orgYtHandle.trim() }]);
    setSelectedOrgs(prev => prev.length < 13 ? [...prev, name] : prev);
    setOrgCustomName('');
    setOrgYtHandle('');
  }

  function getOrgYtHandles(): Record<string, string> {
    const handles = { ...ORG_YT_HANDLES };
    for (const { name, ytHandle } of customOrgs) {
      if (ytHandle) handles[name] = ytHandle;
    }
    return handles;
  }

  // ── Scope helpers ─────────────────────────────────────────────────────────
  function addScope() {
    const v = scopeInput.trim();
    if (v && !scopeKeywords.includes(v)) setScopeKeywords(prev => [...prev, v]);
    setScopeInput('');
  }
  function removeScope(kw: string) { setScopeKeywords(prev => prev.filter(k => k !== kw)); }
  function resetScope() { setScopeKeywords([...DEFAULT_SCOPE]); }

  // ── Previous reports ───────────────────────────────────────────────────────
  const loadPrev = useCallback(async () => {
    try {
      const res = await fetch('/api/outputs');
      if (!res.ok) return;
      const files: ReportFile[] = await res.json();
      if (files.length) setPrevReports(files.slice(0, 10));
    } catch (_) { /* silent */ }
  }, []);

  useEffect(() => { loadPrev(); }, [loadPrev]);

  // Scroll log to bottom when new entries arrive
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  // ── Run pipeline ──────────────────────────────────────────────────────────
  async function startRun() {
    if (!selectedOrgs.length) { alert('Select at least one organisation.'); return; }
    setIsRunning(true);
    setLogs([]);
    setProgress(0);
    setShowProgress(true);
    setResult(null);
    setTrendStatus(null);
    stepsRef.current = 0;
    const TOTAL = 60;

    const bump = () => {
      stepsRef.current = Math.min(stepsRef.current + 1, TOTAL - 1);
      setProgress(Math.round(stepsRef.current / TOTAL * 100));
    };

    const payload = {
      orgs: selectedOrgs,
      dateFrom,
      dateTo,
      clientName,
      scopeKeywords,
      orgYtHandles: getOrgYtHandles(),
    };

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        alert('Error: ' + (err.error || res.status));
        setIsRunning(false);
        return;
      }

      const reader = res.body!.getReader();
      const dec    = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';

        for (const block of parts) {
          if (!block.trim()) continue;
          let event = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:'))  data  = line.slice(5).trim();
          }
          if (!data) continue;
          let p: Record<string, string>;
          try { p = JSON.parse(data) as Record<string, string>; } catch { continue; }

          if (event === 'log') {
            setLogs(prev => [...prev, { msg: p.msg || '', level: p.level || '' }]);
            bump();
            if (p.msg?.includes('[TREND]')) {
              const m = p.msg.trim();
              if (m.includes('Spike detected')) {
                const match = m.match(/Spike detected: "([^"]+)"/);
                setTrendStatus({ msg: `Last run: Trend detected — "${match ? match[1] : 'trend'}"`, good: true });
              } else if (m.includes('No spike detected')) {
                setTrendStatus({ msg: 'Last run: No trend spike detected', good: false });
              }
            }
          } else if (event === 'done') {
            setProgress(100);
            setResult({ htmlName: p.htmlName || '', pptxName: p.pptxName || '' });
            initPreview(p.htmlName || '');
            await loadPrev();
          } else if (event === 'error') {
            setLogs(prev => [...prev, { msg: '✗ Fatal: ' + (p.msg || 'Unknown error'), level: 'err' }]);
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLogs(prev => [...prev, { msg: '✗ Connection error: ' + msg, level: 'err' }]);
    }

    setIsRunning(false);
  }

  // ── Preview helpers ───────────────────────────────────────────────────────
  function initPreview(htmlName: string) {
    setPreviewFile(htmlName);
    setPreviewOpen(false);
    setPreviewCollapsed(false);
    setEditMode(false);
    if (frameRef.current) frameRef.current.src = '';
  }

  function togglePreview() {
    if (!previewOpen) {
      setPreviewOpen(true);
      setPreviewCollapsed(false);
      if (frameRef.current && (!frameRef.current.src || frameRef.current.src === location.href)) {
        frameRef.current.src = '/api/view/' + encodeURIComponent(previewFile);
      }
    } else {
      setPreviewOpen(false);
    }
  }

  function toggleEdit() {
    const frame = frameRef.current;
    const doc = frame?.contentDocument || (frame?.contentWindow?.document);
    if (!doc || !doc.body) {
      alert('Preview not loaded yet — click "Preview & Edit" first to load the report.');
      return;
    }
    const next = !editMode;
    setEditMode(next);
    doc.body.contentEditable = next ? 'true' : 'false';
    doc.body.style.cursor    = next ? 'text' : '';
  }

  function openInTab() {
    if (previewFile) window.open('/api/view/' + encodeURIComponent(previewFile), '_blank');
  }

  function serializeReport(includeActions: boolean): string | null {
    const frame = frameRef.current;
    const doc   = frame?.contentDocument || (frame?.contentWindow?.document);
    if (!doc || !doc.body) return null;

    const wasEditing = doc.body.contentEditable === 'true';
    if (wasEditing) doc.body.contentEditable = 'false';

    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    if (!includeActions) {
      const sec = clone.querySelector('#actions');
      if (sec) sec.remove();
      clone.querySelectorAll('a.nav-a').forEach(a => {
        if (a.getAttribute('href') === '#actions') a.parentNode?.removeChild(a);
      });
    }
    const html = '<!DOCTYPE html>\n' + clone.outerHTML;
    if (wasEditing) doc.body.contentEditable = 'true';
    return html;
  }

  function triggerDownload(html: string | null, filename: string) {
    if (!html) {
      const a = document.createElement('a');
      a.href = '/api/download/' + encodeURIComponent(previewFile);
      a.download = previewFile;
      a.click();
      return;
    }
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadClient() {
    const base = previewFile.replace(/\.html$/i, '') || 'report';
    triggerDownload(serializeReport(false), base + '-client.html');
  }
  function downloadAdmin() {
    const base = previewFile.replace(/\.html$/i, '') || 'report';
    triggerDownload(serializeReport(true), base + '-admin.html');
  }

  function logClass(level: string) {
    if (level === 'head') return 'll lhd';
    if (level === 'ok')   return 'll lok';
    if (level === 'warn') return 'll lwn';
    if (level === 'err')  return 'll ler';
    return 'll';
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <canvas id="bg" ref={canvasRef} />

      <div className="page">

        {/* Header */}
        <header className="hdr a0">
          <div className="wordmark">
            <svg className="wm-icon" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="15" cy="15" r="13.5" stroke="#c9922a" strokeWidth=".7" opacity=".25"/>
              <path d="M15 5.5c-4.5 3.5-7 8-7 12 0 3.6 3.2 6.5 7 6.5s7-2.9 7-6.5c0-4-2.5-8.5-7-12z"
                    stroke="#c9922a" strokeWidth="1.2" fill="none" strokeLinejoin="round"/>
              <line x1="15" y1="17" x2="15" y2="8.5" stroke="#c9922a" strokeWidth="1" strokeLinecap="round"/>
              <circle cx="15" cy="18" r="1.8" fill="#c9922a" opacity=".65"/>
            </svg>
            <span className="wm-text">Emerald AI</span>
          </div>
          <h1>AQ <em>Intelligence</em><br/>Platform</h1>
          <p>Generate comparative air quality media intelligence reports with LLM visibility and social media analysis.</p>
        </header>

        {/* Info bar */}
        <div className="info-box a1">
          <span className="icon">⚡</span>
          <div>
            <strong>API keys pre-loaded.</strong>{' '}
            Serper, Claude, OpenAI, Perplexity, Gemini, and YouTube keys are configured server-side and applied automatically on every run.
          </div>
        </div>

        {/* Report settings */}
        <div className="card a2">
          <div className="card-title">Report settings</div>

          <div className="fld">
            <label>
              Organisations{' '}
              <span style={{
                color: selectedOrgs.length >= 13 ? 'var(--warn)' : 'var(--amb)',
                fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, marginLeft: 4,
              }}>
                ({selectedOrgs.length} selected{selectedOrgs.length >= 13 ? ' — max' : ''})
              </span>
            </label>
            <div className="org-grid">
              {allOrgs.map(({ name, ytHandle }) => (
                <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={selectedOrgs.includes(name)}
                    onChange={() => toggleOrg(name)}
                    style={{ accentColor: 'var(--amb)', width: 13, height: 13 }}
                  />
                  <span>{name}</span>
                  {ytHandle ? (
                    ytHandle.startsWith('UC')
                      ? <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#4caf74', background: 'rgba(76,175,116,.08)', border: '1px solid rgba(76,175,116,.25)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 }} title={ytHandle}>YT ✓</span>
                      : <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: 'var(--mt)', background: 'var(--sur3)', border: '1px solid var(--bdr)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>{ytHandle}</span>
                  ) : (
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: 'var(--bad)', background: 'rgba(224,92,92,.08)', border: '1px solid rgba(224,92,92,.2)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>no YT</span>
                  )}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <input
                value={orgCustomName}
                onChange={e => setOrgCustomName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomOrg()}
                placeholder="Organisation name…"
                style={{ flex: 2, minWidth: 160, background: 'var(--sur2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 11px', color: 'var(--tx)', fontSize: 11.5, fontFamily: "'JetBrains Mono',monospace", outline: 'none' }}
              />
              <input
                value={orgYtHandle}
                onChange={e => setOrgYtHandle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomOrg()}
                placeholder="@YouTubeHandle"
                style={{ flex: 1, minWidth: 120, background: 'var(--sur2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 11px', color: 'var(--tx)', fontSize: 11.5, fontFamily: "'JetBrains Mono',monospace", outline: 'none' }}
              />
              <button onClick={addCustomOrg} className="mini-btn">+ Add</button>
            </div>
            <div className="hint">Select up to 13. YouTube handle is used to filter videos to the org's official channel only.</div>
          </div>

          <div className="row3">
            <div className="fld">
              <label>Date From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div className="fld">
              <label>Date To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <div className="fld">
              <label>Client Name</label>
              <input value={clientName} onChange={e => setClientName(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Scope keywords */}
        <div className="card a3">
          <div
            className="card-title"
            onClick={() => setScopeOpen(o => !o)}
            style={{ cursor: 'pointer', userSelect: 'none' }}
          >
            Scope Keywords <span className="badge badge-opt">optional</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--mt)' }}>
              {scopeOpen ? '▴ hide' : '▾ show'}
            </span>
          </div>
          {scopeOpen && (
            <div>
              <div className="hint" style={{ marginBottom: 10 }}>
                Keywords that must appear in articles for them to count as AQ coverage.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {scopeKeywords.map(kw => (
                  <span key={kw} className="stag">
                    {esc(kw)}
                    <span className="rm" onClick={() => removeScope(kw)} title="Remove">×</span>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 7 }}>
                <input
                  value={scopeInput}
                  onChange={e => setScopeInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addScope()}
                  placeholder="Add keyword…"
                  style={{ flex: 1, background: 'var(--sur2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '7px 11px', color: 'var(--tx)', fontSize: 11.5, fontFamily: "'JetBrains Mono',monospace", outline: 'none' }}
                />
                <button onClick={addScope} className="mini-btn">+ Add</button>
                <button onClick={resetScope} className="mini-btn" style={{ color: 'var(--mt)' }}>Reset</button>
              </div>
            </div>
          )}
        </div>

        {/* Run button */}
        <button
          className="run-btn a4"
          onClick={startRun}
          disabled={isRunning}
          aria-label="Generate report"
        >
          {isRunning && <div className="btn-spin" aria-hidden="true" />}
          {!isRunning && <span aria-hidden="true">▶</span>}
          <span>{isRunning ? 'Generating…' : 'Generate Report'}</span>
        </button>

        {/* Trend status */}
        {trendStatus && (
          <div
            className="trend-status"
            role="status"
            aria-live="polite"
            style={{ color: trendStatus.good ? '#4caf74' : 'var(--mt2)', borderColor: trendStatus.good ? 'rgba(76,175,116,.3)' : 'var(--bdr)' }}
          >
            {trendStatus.msg}
          </div>
        )}

        {/* Progress + log */}
        {showProgress && (
          <div style={{ marginTop: 18 }} role="status" aria-live="polite">
            <div className="prog-label">
              <span>Processing pipeline…</span>
              <span>{progress}%</span>
            </div>
            <div className="prog-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`prog-fill${progress > 0 && progress < 100 ? ' active' : ''}`}
                style={{ width: progress + '%' }}
              />
            </div>
            <div className="log-box" ref={logBoxRef} aria-label="Pipeline log">
              {logs.map((line, i) => (
                <div key={i} className={logClass(line.level)}>{line.msg}</div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="results" role="region" aria-label="Report ready">
            <div className="res-hdr">
              <div className="res-check" aria-hidden="true">✓</div>
              <div className="res-title">Report ready</div>
            </div>
            <div className="dl-buttons">
              <a
                className="dl-btn dl-html"
                href={'/api/download/' + encodeURIComponent(result.htmlName)}
                download={result.htmlName}
              >
                ↓ HTML Report
              </a>
              <a
                className="dl-btn dl-pptx"
                href={'/api/download/' + encodeURIComponent(result.pptxName)}
                download={result.pptxName}
              >
                ↓ PowerPoint
              </a>
              <button
                className="dl-btn"
                onClick={togglePreview}
                style={{ background: 'var(--sur3)', color: 'var(--tx2)', border: '1px solid var(--bdr2)' }}
              >
                {previewOpen ? '✕ Close Preview' : '⊞ Preview & Edit'}
              </button>
            </div>
          </div>
        )}

        {/* Inline preview + edit panel */}
        {result && previewOpen && (
          <div className="preview-panel">
            <div className="preview-bar">
              <div className="preview-bar-title">
                Preview &nbsp;·&nbsp; <span>{previewFile}</span>
              </div>
              <div className="preview-actions">
                <button className="pv-btn pv-btn-ghost" onClick={openInTab} title="Open in new tab">↗ New tab</button>
                <button
                  className={`pv-btn pv-btn-edit${editMode ? ' active' : ''}`}
                  onClick={toggleEdit}
                >
                  {editMode ? '✓ Editing ON' : '✏ Enable Editing'}
                </button>
                <div className="dl-split" style={{ position: 'relative' }}>
                  <button className="pv-btn pv-btn-dl" onClick={downloadClient} title="Download client-facing report">↓ Download</button>
                  <button
                    className="dl-chevron"
                    onClick={e => { e.stopPropagation(); setDlMenuOpen(o => !o); }}
                    title="More download options"
                  >▾</button>
                  {dlMenuOpen && (
                    <div className="dl-menu" onClick={() => setDlMenuOpen(false)}>
                      <div className="dl-menu-label">Download as</div>
                      <button onClick={downloadClient}>↓ Client Report <span style={{ fontSize: 10, color: 'var(--mt)' }}>— Action Matrix excluded</span></button>
                      <button onClick={downloadAdmin}>↓ Admin (Full Report) <span style={{ fontSize: 10, color: 'var(--mt)' }}>— includes Action Matrix</span></button>
                    </div>
                  )}
                </div>
                <button
                  className="preview-collapse-btn"
                  onClick={() => setPreviewCollapsed(c => !c)}
                >
                  {previewCollapsed ? '▾ expand' : '▴ collapse'}
                </button>
              </div>
            </div>
            {editMode && (
              <div className="edit-banner">
                <strong>Editing mode on.</strong>{' '}
                Click any text in the report below to edit it directly, then click <strong>Download Final</strong> to save your changes.
              </div>
            )}
            <div className={`preview-frame-wrap${previewCollapsed ? ' collapsed' : ''}`}>
              <iframe
                ref={frameRef}
                title="Report preview"
                allow="same-origin"
              />
            </div>
          </div>
        )}

        {/* Previous reports */}
        {prevReports.length > 0 && (
          <div className="prev-reports" role="complementary" aria-label="Previous reports">
            <div className="prev-title">Previous reports</div>
            <div className="prev-list">
              {prevReports.map(f => (
                <div key={f.name} className="prev-item">
                  <span className="prev-item-name">
                    {f.name.endsWith('.pptx') ? '📊' : '📄'} {f.name}
                  </span>
                  <span className="prev-item-meta">{f.size}KB · {f.mtime}</span>
                  <a href={'/api/download/' + encodeURIComponent(f.name)} download={f.name}>Download</a>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Close dl menu on outside click */}
      {dlMenuOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 98 }}
          onClick={() => setDlMenuOpen(false)}
        />
      )}
    </>
  );
}
