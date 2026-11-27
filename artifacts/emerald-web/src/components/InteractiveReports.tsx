import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

// The Interactive tab: the same list as Reports, with an "Interact" button on each row. A row opens the period's social posts,
// each in ONE scope (air quality / climate / sustainability / other), as an explorable view: every number is a control.

interface IndexEntry { name: string; size: number; mtime: string; dateFrom: string; dateTo: string; orgs: number; posts: number; counts?: Record<string, number> }
type Platform = "li" | "x" | "ig" | "yt";
interface Post { o: string; p: Platform; s: string | null; d: string; t: string; u: string; l: number; c: number; h: number; v: number }
interface Article { o: string; k: "press" | "tv"; x: string; s: string; d: string; t: string; u: string; z?: number }
interface ScopeInfo { id: string; label: string; rule: string; keywords: string[] }
interface Dataset { report: string | null; dateFrom: string; dateTo: string; scopes: { id: string; label: string }[]; scopeInfo?: ScopeInfo[]; articles?: Article[]; articlesSample?: boolean; orgs: string[]; unlabelled: number; posts: Post[] }

const PLATFORMS: { id: Platform; label: string }[] = [{ id: "li", label: "LinkedIn" }, { id: "x", label: "X" }, { id: "ig", label: "Instagram" }, { id: "yt", label: "YouTube" }];
const PLATFORM_LABEL: Record<string, string> = { li: "LinkedIn", x: "X", ig: "Instagram", yt: "YouTube" };
const ALL_PLATFORMS: Platform[] = ["li", "x", "ig", "yt"];
const KIND_LABEL: Record<string, string> = { press: "Press", tv: "TV" };
// Mid-lightness colours: each holds 3:1 against both the light and the dark card.
const SCOPE_COLOUR: Record<string, string> = { "air-quality": "#3d8ef0", climate: "#e8743b", sustainability: "#34a56f", other: "#8b93a1" };
const SCOPE_NOTE: Record<string, string> = {
  "air-quality": "Air quality, air pollution, smog, PM2.5, clean-air policy and its health effects.",
  climate: "Climate change, heat and extreme weather, emissions, COP, climate policy and finance.",
  sustainability: "Sustainability, energy transition, waste, water, biodiversity, sustainable cities and mobility.",
  other: "None of these: events, hiring, greetings, awards, organisation news.",
};
const TOPIC_BUTTONS: { id: string; label: string }[] = [{ id: "full", label: "Full report" }, { id: "air-quality", label: "Air quality" }, { id: "sustainability", label: "Sustainability" }, { id: "climate", label: "Climate" }];

// "total" = posts in the scopes on show, "all" = posts in every scope, "name" = A to Z, or a scope id
type SortKey = "total" | "all" | "name" | string;
interface SortState { key: SortKey; dir: 1 | -1 }
const DEFAULT_SORT: SortState = { key: "total", dir: -1 };

const dim = "var(--text-sub)";
const card: React.CSSProperties = { background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 14 };
const mono: React.CSSProperties = { fontFamily: "'DM Mono', monospace" };
const chip = (on: boolean): React.CSSProperties => ({
  padding: "5px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13.5, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif",
  background: on ? "var(--elevate-2)" : "transparent", color: on ? "var(--text-main)" : dim, border: `1px solid ${on ? "var(--text-main)" : "var(--border-col)"}`,
});

const shortOrg = (o: string) => (o.length > 24 ? `${o.slice(0, 23)}…` : o);
const fmtDate = (s: string) => s.slice(0, 10);
const engagement = (p: Post) => p.l + p.c + p.h;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "0%");
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A named section of the explorer.
function Section({ n, title, note, actions, children }: { n: number; title: string; note?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 700, color: "var(--text-main)" }}><span style={{ color: "var(--accent-amber)", ...mono, fontSize: 14, marginRight: 8 }}>{String(n).padStart(2, "0")}</span>{title}</div>
          {note && <div style={{ fontSize: 13.5, color: dim, marginTop: 2 }}>{note}</div>}
        </div>
        {actions && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export default function InteractiveReports() {
  const [list, setList] = useState<IndexEntry[] | null>(null);
  const [listError, setListError] = useState("");
  const [open, setOpen] = useState<IndexEntry | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/interactive", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) setList(Array.isArray(d.reports) ? d.reports : []); })
      .catch(() => { if (live) { setList([]); setListError("The list could not be loaded."); } });
    return () => { live = false; };
  }, []);

  if (open) return <Explorer entry={open} onBack={() => setOpen(null)} />;

  return (
    <div style={{ paddingTop: 40 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent-amber)", marginBottom: 10 }}>Interactive</div>
        <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 36, fontWeight: 700, letterSpacing: "-.02em", color: "var(--text-main)", margin: 0 }}>Interactive Reports</h2>
        <p style={{ fontSize: 15, color: dim, marginTop: 6 }}>Every social post of a period, sorted into Air quality, Climate, Sustainability or Other. Press Interact to explore it.</p>
      </div>
      {list === null ? (
        <div style={{ color: dim, padding: "40px 0", textAlign: "center" }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ ...card, textAlign: "center", padding: "50px 20px", color: dim, fontSize: 17 }}>{listError || "No interactive reports yet."}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((f) => (
            <div key={f.name} style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", fontSize: 15, gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 28, flexShrink: 0 }}>📄</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-main)", ...mono, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                  <div style={{ color: dim, ...mono, fontSize: 12, marginTop: 3 }}>{f.size} KB · {f.mtime} · {f.dateFrom} → {f.dateTo} · {f.posts} posts</div>
                </div>
              </div>
              <button
                onClick={() => setOpen(f)}
                style={{ padding: "7px 18px", borderRadius: 8, background: "rgba(201,146,42,.12)", color: "var(--accent-amber)", border: "1px solid rgba(201,146,42,.25)", fontSize: 18, fontWeight: 600, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}
              >⚡ Interact</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Explorer({ entry, onBack }: { entry: IndexEntry; onBack: () => void }) {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState("");
  const [platforms, setPlatforms] = useState<Platform[]>(ALL_PLATFORMS);
  const [kinds, setKinds] = useState<("press" | "tv")[]>(["press", "tv"]);
  const [scopes, setScopes] = useState<string[] | null>(null); // null = all
  const [focus, setFocus] = useState<string[]>([]);
  const [percent, setPercent] = useState(false);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [shown, setShown] = useState(20);
  const [showRules, setShowRules] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailNote, setEmailNote] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/interactive/${encodeURIComponent(entry.name)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Dataset) => { if (live) setDs(d); })
      .catch(() => { if (live) setError("This report could not be loaded."); });
    return () => { live = false; };
  }, [entry.name]);

  const scopeIds = useMemo(() => (ds ? ds.scopes.map((s) => s.id) : []), [ds]);
  const labelOf = useCallback((id: string) => ds?.scopes.find((s) => s.id === id)?.label ?? id, [ds]);
  const visible = scopes ?? scopeIds; // the scopes on show

  // posts after the platform filter (the scope filter is applied where it matters: the stacks, the list)
  const byPlatform = useMemo(() => (ds ? ds.posts.filter((p) => platforms.includes(p.p)) : []), [ds, platforms]);

  const rows = useMemo(() => {
    if (!ds) return [];
    const out = ds.orgs.map((o) => {
      const mine = byPlatform.filter((p) => p.o === o);
      const counts: Record<string, number> = {};
      for (const s of scopeIds) counts[s] = mine.filter((p) => p.s === s).length;
      const all = mine.length;
      const vis = visible.reduce((n, s) => n + counts[s], 0);
      return { org: o, counts, all, vis };
    });
    const value = (r: (typeof out)[number]) => (sort.key === "total" ? r.vis : sort.key === "all" ? r.all : r.counts[sort.key] ?? 0);
    return out.sort((a, b) => (sort.key === "name" ? sort.dir * a.org.localeCompare(b.org) : sort.dir * (value(a) - value(b)) || a.org.localeCompare(b.org)));
  }, [ds, byPlatform, scopeIds, visible, sort]);

  const chartData = useMemo(() => rows.map((r) => {
    const row: Record<string, string | number> = { org: r.org };
    for (const s of visible) row[s] = percent ? (r.vis ? Math.round((r.counts[s] / r.vis) * 1000) / 10 : 0) : r.counts[s];
    return row;
  }), [rows, visible, percent]);

  // articles: the same organisation x scope counts, after the press / TV filter
  const artRows = useMemo(() => {
    if (!ds) return [];
    const mine = (ds.articles ?? []).filter((a) => kinds.includes(a.k));
    const out = ds.orgs.map((o) => {
      const counts: Record<string, number> = {}, press: Record<string, number> = {}, tv: Record<string, number> = {}, sample: Record<string, number> = {};
      for (const sc of scopeIds) {
        const xs = mine.filter((a) => a.o === o && a.s === sc);
        counts[sc] = xs.length; press[sc] = xs.filter((a) => a.k === "press").length; tv[sc] = xs.filter((a) => a.k === "tv").length; sample[sc] = xs.filter((a) => a.z).length;
      }
      const all = scopeIds.reduce((n, sc) => n + counts[sc], 0);
      const vis = visible.reduce((n, sc) => n + counts[sc], 0);
      return { org: o, counts, press, tv, sample, all, vis };
    });
    return out.sort((a, b) => (sort.key === "name" ? sort.dir * a.org.localeCompare(b.org) : (sort.key === "all" ? b.all - a.all : sort.key === "total" ? b.vis - a.vis : (b.counts[sort.key] ?? 0) - (a.counts[sort.key] ?? 0)) || a.org.localeCompare(b.org)));
  }, [ds, kinds, scopeIds, visible, sort]);
  const artData = useMemo(() => artRows.map((r) => {
    const row: Record<string, string | number> = { org: r.org };
    for (const sc of visible) row[sc] = percent ? (r.vis ? Math.round((r.counts[sc] / r.vis) * 1000) / 10 : 0) : r.counts[sc];
    return row;
  }), [artRows, visible, percent]);
  const artTotal = artRows.reduce((n, r) => n + r.vis, 0);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const s of scopeIds) t[s] = byPlatform.filter((p) => p.s === s).length;
    return t;
  }, [byPlatform, scopeIds]);
  const totalAll = byPlatform.length;

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const toggleFocus = (o: string) => { setFocus((f) => toggle(f, o)); setShown(20); };
  // The first click on a scope shows only that scope; further clicks add or remove scopes; none left = all again.
  const toggleScope = (id: string) => {
    setScopes((cur) => {
      if (cur === null) return [id];
      const next = toggle(cur, id);
      return next.length === 0 || next.length === scopeIds.length ? null : next;
    });
    setShown(20);
  };
  // A column heading sorts by that column (largest first); the same heading again reverses it.
  const sortBy = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const dirty = focus.length > 0 || scopes !== null || platforms.length !== ALL_PLATFORMS.length || kinds.length !== 2 || percent || sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir;
  const reset = () => { setFocus([]); setScopes(null); setPlatforms(ALL_PLATFORMS); setKinds(["press", "tv"]); setPercent(false); setSort(DEFAULT_SORT); setShown(20); };

  const focused = new Set(focus);
  // The topic a stand-alone report can have: one subject, or the full report.
  const topic = scopes !== null && scopes.length === 1 && scopes[0] !== "other" ? scopes[0] : "full";
  const reportQuery = `topic=${encodeURIComponent(topic)}${focus.length ? `&orgs=${encodeURIComponent(focus.join("|"))}` : ""}`;
  const reportUrl = `/api/interactive/${encodeURIComponent(entry.name)}/report?${reportQuery}`;
  const dimmed = (o: string) => focus.length > 0 && !focused.has(o);

  const list = useMemo(() => byPlatform
    .filter((p) => p.s && visible.includes(p.s) && (focus.length === 0 || focus.includes(p.o)))
    .sort((a, b) => engagement(b) - engagement(a) || b.d.localeCompare(a.d)), [byPlatform, visible, focus]);

  // the benchmark table: total of the field, the median organisation, and the selected organisations
  const benchmark = useMemo(() => {
    const cols = [...scopeIds, "all"];
    const val = (r: (typeof rows)[number], c: string) => (c === "all" ? r.all : r.counts[c]);
    const total: Record<string, number> = {}, med: Record<string, number> = {};
    for (const c of cols) { const xs = rows.map((r) => val(r, c)); total[c] = xs.reduce((a, b) => a + b, 0); med[c] = median(xs); }
    const mine = focus.map((o) => rows.find((r) => r.org === o)).filter((r): r is (typeof rows)[number] => !!r);
    return { cols, total, med, mine, val };
  }, [rows, scopeIds, focus]);

  async function sendEmail() {
    setEmailBusy(true); setEmailMsg(null);
    try {
      const res = await fetch("/api/interactive/email", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: entry.name, topic, orgs: focus, to: emailTo.trim(), note: emailNote.trim() }) });
      const data = await res.json().catch(() => ({}));
      setEmailMsg(res.ok ? { ok: true, text: `Sent to ${emailTo.trim()}: ${data.file ?? "the report"}` } : { ok: false, text: data.error || "The email could not be sent." });
    } catch { setEmailMsg({ ok: false, text: "The email could not be sent." }); }
    setEmailBusy(false);
  }

  if (error) return <div style={{ paddingTop: 40 }}><button onClick={onBack} style={chip(false)}>← Back</button><div style={{ ...card, padding: 30, marginTop: 16, color: dim }}>{error}</div></div>;
  if (!ds) return <div style={{ paddingTop: 40 }}><button onClick={onBack} style={chip(false)}>← Back</button><div style={{ color: dim, padding: "40px 0", textAlign: "center" }}>Loading…</div></div>;

  const baseName = entry.name.replace(/\.json$/, "");
  const colLabel = (c: string) => (c === "all" ? "All posts" : labelOf(c));
  const platformNote = platforms.length === ALL_PLATFORMS.length ? "all platforms" : platforms.map((p) => PLATFORM_LABEL[p]).join(" + ");

  const tip = (p: { active?: boolean; payload?: { payload: { org: string } }[] }) => {
    if (!p.active || !p.payload?.length) return null;
    const org = p.payload[0].payload.org;
    const r = rows.find((x) => x.org === org);
    if (!r) return null;
    const mine = byPlatform.filter((x) => x.o === org);
    return (
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "8px 12px", fontSize: 13, ...mono, color: "var(--text-main)", boxShadow: "0 8px 24px rgba(0,0,0,.25)", maxWidth: 340 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{org}</div>
        {visible.map((s) => (
          <div key={s} style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: SCOPE_COLOUR[s] }} />
              <strong>{labelOf(s)}: {r.counts[s]}</strong><span style={{ color: dim }}>({pct(r.counts[s], r.all)} of its posts)</span>
            </div>
            <div style={{ paddingLeft: 14, color: dim }}>{PLATFORMS.map((pl) => `${pl.label} ${mine.filter((x) => x.s === s && x.p === pl.id).length}`).join(" · ")}</div>
          </div>
        ))}
        <div style={{ borderTop: "1px solid var(--border-col)", marginTop: 4, paddingTop: 4, color: dim }}>All posts in this view: {r.all} · click to focus</div>
      </div>
    );
  };

  const artTip = (p: { active?: boolean; payload?: { payload: { org: string } }[] }) => {
    if (!p.active || !p.payload?.length) return null;
    const org = p.payload[0].payload.org;
    const r = artRows.find((x) => x.org === org);
    if (!r) return null;
    return (
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "8px 12px", fontSize: 13, ...mono, color: "var(--text-main)", boxShadow: "0 8px 24px rgba(0,0,0,.25)", maxWidth: 340 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{org}</div>
        {visible.map((sc) => (
          <div key={sc} style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: SCOPE_COLOUR[sc] }} />
              <strong>{labelOf(sc)}: {r.counts[sc]}</strong><span style={{ color: dim }}>({pct(r.counts[sc], r.all)} of its articles)</span>
            </div>
            <div style={{ paddingLeft: 14, color: dim }}>Press {r.press[sc]} · TV {r.tv[sc]}{r.sample[sc] ? ` · ${r.sample[sc]} sample` : ""}</div>
          </div>
        ))}
        <div style={{ borderTop: "1px solid var(--border-col)", marginTop: 4, paddingTop: 4, color: dim }}>All articles in this view: {r.all} · click to focus</div>
      </div>
    );
  };

  const maxCell: Record<string, number> = {};
  for (const s of scopeIds) maxCell[s] = Math.max(1, ...rows.map((r) => r.counts[s]));

  const th: React.CSSProperties = { cursor: "pointer", fontWeight: 700, padding: "4px 8px", userSelect: "none", whiteSpace: "nowrap" };
  const csvBenchmark = () => downloadCsv(`${baseName}-benchmark.csv`, [
    ["", ...benchmark.cols.map(colLabel)],
    ["Total (all organisations)", ...benchmark.cols.map((c) => benchmark.total[c])],
    [`Median organisation (of ${rows.length})`, ...benchmark.cols.map((c) => benchmark.med[c])],
    ...benchmark.mine.map((r) => [r.org, ...benchmark.cols.map((c) => benchmark.val(r, c))]),
  ]);
  const csvAll = () => downloadCsv(`${baseName}-organisations.csv`, [
    ["Organisation", ...benchmark.cols.map(colLabel)],
    ...rows.map((r) => [r.org, ...benchmark.cols.map((c) => benchmark.val(r, c))]),
  ]);

  return (
    <div style={{ paddingTop: 32 }}>
      <a
        href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        title="Click to go to the top"
        style={{ position: "fixed", top: 66, right: 16, zIndex: 40, ...mono, fontSize: 13, fontWeight: 600, padding: "7px 14px", borderRadius: 20, background: "var(--elevate-1)", border: "1px solid var(--border-col)", color: "var(--text-main)", textDecoration: "none", boxShadow: "0 2px 8px rgba(0,0,0,.18)" }}
      >{topic === "full" ? "Full report" : `${labelOf(topic)} report`} <span style={{ fontWeight: 400, opacity: 0.85 }}>· {ds.dateFrom} → {ds.dateTo}</span></a>
      <button onClick={onBack} style={{ ...chip(false), marginBottom: 14 }}>← All interactive reports</button>
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent-amber)", marginBottom: 8 }}>Interactive · All Scope</div>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 30, fontWeight: 700, letterSpacing: "-.02em", color: "var(--text-main)", margin: 0, wordBreak: "break-all" }}>{baseName}</h2>
      <p style={{ fontSize: 15, color: dim, marginTop: 6 }}>
        {ds.dateFrom} → {ds.dateTo} · {ds.posts.length} posts from {ds.orgs.length} organisations. Each post is in one scope. Click a scope, a bar, a number, a column heading or a platform to filter or sort everything on the page.
        {ds.unlabelled > 0 && <span style={{ color: "#e05a5a" }}> {ds.unlabelled} posts have no scope yet.</span>}
      </p>
      <button style={{ ...chip(showRules), marginTop: 4 }} onClick={() => setShowRules((v) => !v)}>{showRules ? "Hide" : "ⓘ How posts are sorted"}</button>
      {showRules && (
        <div style={{ ...card, padding: 16, marginTop: 10 }}>
          <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.5, marginBottom: 12 }}>
            Each post is read as a whole and put in the ONE scope it is mainly about. A passing mention does not decide it: a festival greeting that says “clean air”, a hiring notice, or a newsletter of many subjects is <strong>Other</strong> unless one subject clearly leads. The keywords below are the ones the weekly reports use to find each subject's posts; they are shown for transparency and a keyword on its own does not set the scope.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {(ds.scopeInfo ?? ds.scopes.map((s) => ({ id: s.id, label: s.label, rule: SCOPE_NOTE[s.id] ?? "", keywords: [] }))).map((s) => (
              <div key={s.id} style={{ borderTop: `3px solid ${SCOPE_COLOUR[s.id]}`, background: "var(--elevate-2)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 13.5, color: dim, lineHeight: 1.45, marginBottom: 8 }}>{s.rule}</div>
                {s.keywords.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {s.keywords.map((k) => <span key={k} style={{ fontSize: 12, ...mono, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border-col)", color: "var(--text-main)" }}>{k}</span>)}
                  </div>
                ) : <div style={{ fontSize: 12.5, color: dim }}>No keywords: anything not mainly about the three subjects.</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <Section n={1} title="Choose your report" note="Pick a topic and, if you like, one or more organisations. Everything below and the report you send follow this choice.">
        <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: dim, minWidth: 64 }}>Topic:</span>
            {TOPIC_BUTTONS.map((t) => (
              <button key={t.id} style={chip(t.id === topic && (t.id !== "full" || scopes === null))} onClick={() => { setScopes(t.id === "full" ? null : [t.id]); setShown(20); }}>{t.label}</button>
            ))}
            {scopes !== null && !(scopes.length === 1 && scopes[0] !== "other") && <span style={{ fontSize: 12.5, color: dim }}>(a mix of scopes is shown here; the report you send will be the full report)</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: dim, minWidth: 64 }}>Organisations:</span>
            {focus.length === 0 && <span style={{ fontSize: 13.5, color: dim }}>all {ds.orgs.length}</span>}
            {focus.map((o) => <button key={o} style={chip(true)} onClick={() => toggleFocus(o)} title="Remove">{o} ✕</button>)}
            <select
              value="" onChange={(e) => { if (e.target.value) setFocus((f) => (f.includes(e.target.value) ? f : [...f, e.target.value])); }}
              style={{ background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "6px 10px", color: "var(--text-main)", fontSize: 13.5 }}
            >
              <option value="">Add an organisation…</option>
              {[...ds.orgs].sort((x, y) => x.localeCompare(y)).filter((o) => !focus.includes(o)).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {focus.length > 0 && <button style={chip(false)} onClick={() => setFocus([])}>All organisations</button>}
          </div>
        </div>
      </Section>

      <Section n={2} title="Send this report" note="The report you have chosen, as a stand-alone page: scope summary, a chart for each of posts and articles, the benchmark table and the top posts.">
        <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <a href={reportUrl} target="_blank" rel="noopener noreferrer" style={{ ...chip(false), textDecoration: "none" }}>Open it ↗</a>
            <a href={`${reportUrl}&download=1`} style={{ ...chip(false), textDecoration: "none" }}>⬇ Download</a>
            <span style={{ fontSize: 13, color: dim }}>{topic === "full" ? "Full report" : `${labelOf(topic)} report`}{focus.length ? ` · ${focus.length === 1 ? focus[0] : `${focus.length} organisations`}` : " · all organisations"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="Email address" type="email" style={{ background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "7px 10px", color: "var(--text-main)", fontSize: 14, minWidth: 240 }} />
            <input value={emailNote} onChange={(e) => setEmailNote(e.target.value)} placeholder="Note (optional)" maxLength={500} style={{ background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "7px 10px", color: "var(--text-main)", fontSize: 14, flex: 1, minWidth: 220 }} />
            <button disabled={emailBusy || !emailTo.includes("@")} onClick={sendEmail} style={{ ...chip(true), opacity: emailBusy || !emailTo.includes("@") ? 0.5 : 1 }}>{emailBusy ? "Sending…" : "✉ Send"}</button>
          </div>
          {emailMsg && <div style={{ fontSize: 13.5, color: emailMsg.ok ? "var(--accent-green)" : "#e05a5a" }}>{emailMsg.text}</div>}
          <div style={{ fontSize: 12.5, color: dim }}>Admins can send to any address; other accounts only to their own.</div>
        </div>
      </Section>

      <Section n={3} title="Scope summary" note="How many posts are in each scope. Click a scope to show only it; click more to add them.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
          <button onClick={() => { setScopes(null); setShown(20); }} style={{ ...card, textAlign: "left", padding: "12px 14px", cursor: "pointer", borderColor: scopes === null ? "var(--text-main)" : undefined, color: "var(--text-main)" }}>
            <div style={{ fontSize: 13, color: dim, textTransform: "uppercase", letterSpacing: ".08em" }}>All scopes</div>
            <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>{totalAll}</div>
            <div style={{ fontSize: 12.5, color: dim }}>posts{platforms.length !== ALL_PLATFORMS.length ? " on the chosen platforms" : ""}</div>
          </button>
          {ds.scopes.map((s) => {
            const on = scopes === null || scopes.includes(s.id);
            return (
              <button key={s.id} title={SCOPE_NOTE[s.id]} onClick={() => toggleScope(s.id)} style={{ ...card, textAlign: "left", padding: "12px 14px", cursor: "pointer", opacity: on ? 1 : 0.45, borderColor: scopes !== null && on ? SCOPE_COLOUR[s.id] : undefined, color: "var(--text-main)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: dim, textTransform: "uppercase", letterSpacing: ".08em" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: SCOPE_COLOUR[s.id] }} />{s.label}</div>
                <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>{totals[s.id]}</div>
                <div style={{ fontSize: 12.5, color: dim }}>{pct(totals[s.id], totalAll)} of posts</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section n={4} title="Filters" note="Apply to every section below.">
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: dim }}>Platform:</span>
            {PLATFORMS.map((pl) => <button key={pl.id} style={chip(platforms.includes(pl.id))} onClick={() => { setPlatforms((cur) => { const n = toggle(cur, pl.id); return n.length === 0 ? cur : n; }); setShown(20); }}>{pl.label}</button>)}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: dim }}>Articles:</span>
            {(["press", "tv"] as const).map((k) => <button key={k} style={chip(kinds.includes(k))} onClick={() => setKinds((cur) => { const n = toggle(cur, k); return n.length === 0 ? cur : n; })}>{KIND_LABEL[k]}</button>)}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 13.5, color: dim }}>Charts show:</span>
            <button style={chip(!percent)} onClick={() => setPercent(false)}>Posts</button>
            <button style={chip(percent)} onClick={() => setPercent(true)}>% of each organisation's posts</button>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 13.5, color: dim }}>Order by:</span>
            <select value={sort.key} onChange={(e) => setSort({ key: e.target.value, dir: e.target.value === "name" ? 1 : -1 })} style={{ background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "6px 10px", color: "var(--text-main)", fontSize: 13.5 }}>
              <option value="total">Most posts in the scopes shown</option>
              <option value="all">Most posts overall</option>
              <option value="name">Organisation A to Z</option>
              {ds.scopes.map((s) => <option key={s.id} value={s.id}>Most {s.label}</option>)}
            </select>
          </div>
          {dirty && <button style={{ ...chip(false), color: "var(--accent-amber)" }} onClick={reset}>Reset all</button>}
        </div>
      </Section>

      <Section n={5} title="Posts by scope (chart)" note={`Posts per organisation in each scope, ${platformNote}. Click a name or a bar to focus; hover for the numbers.`}>
        <div style={{ ...card, padding: "18px 12px 8px" }}>
          <div style={{ width: "100%", height: Math.max(360, rows.length * 30 + 50) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, left: 20, bottom: 4 }} barCategoryGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-col)" horizontal={false} />
                <XAxis type="number" domain={percent ? [0, 100] : [0, "auto"]} allowDecimals={false} tick={{ fill: "var(--text-sub)", fontSize: 12, fontFamily: "'DM Mono', monospace" }} axisLine={{ stroke: "var(--border-col)" }} tickLine={false} unit={percent ? "%" : ""} />
                <YAxis
                  type="category" dataKey="org" width={200} interval={0} axisLine={false} tickLine={false}
                  tick={(tp: { x: number; y: number; payload: { value: string } }) => (
                    <text x={tp.x} y={tp.y} dy={4} textAnchor="end" onClick={() => toggleFocus(tp.payload.value)} style={{ cursor: "pointer", fill: dimmed(tp.payload.value) ? "var(--text-dim)" : "var(--text-main)", fontSize: 12.5, fontWeight: focused.has(tp.payload.value) ? 700 : 400, fontFamily: "'DM Mono', monospace" }}>
                      {shortOrg(tp.payload.value)}
                    </text>
                  )}
                />
                <Tooltip content={tip as never} cursor={{ fill: "rgba(128,128,128,.12)" }} />
                {visible.map((s) => (
                  <Bar key={s} dataKey={s} stackId="s" fill={SCOPE_COLOUR[s]} cursor="pointer" onClick={(d: { org?: string }) => d?.org && toggleFocus(d.org)} isAnimationActive={false}>
                    {chartData.map((r) => <Cell key={String(r.org)} fill={SCOPE_COLOUR[s]} fillOpacity={dimmed(String(r.org)) ? 0.22 : 1} />)}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 13, color: dim, padding: "6px 8px 4px" }}>
            {focus.length ? <>Showing {focus.map((o, i) => <span key={o}>{i ? ", " : ""}<strong style={{ color: "var(--text-main)" }}>{o}</strong></span>)}; the other organisations are faded. Click a name or bar again to deselect.</> : "Click an organisation (its name or bar) to focus on it. Hover for the numbers."}
          </div>
        </div>
      </Section>

      <Section n={6} title="Press and TV articles by scope (chart)" note={`Articles per organisation in each scope, ${kinds.length === 2 ? "press and TV" : KIND_LABEL[kinds[0]]}. Click a name or a bar to focus; hover for the numbers.`}>
        {ds.articlesSample && (
          <div style={{ background: "rgba(201,146,42,.12)", border: "1px solid rgba(201,146,42,.35)", borderRadius: 8, padding: "8px 12px", fontSize: 13.5, color: "var(--text-main)", marginBottom: 10 }}>
            <strong>Sample data.</strong> The air-quality articles are the ones collected. The climate, sustainability and other articles are placeholders to show the chart; they are not real articles. Fetching articles on every subject is not built yet.
          </div>
        )}
        <div style={{ ...card, padding: "18px 12px 8px" }}>
          <div style={{ width: "100%", height: Math.max(360, artRows.length * 30 + 50) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={artData} layout="vertical" margin={{ top: 4, right: 24, left: 20, bottom: 4 }} barCategoryGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-col)" horizontal={false} />
                <XAxis type="number" domain={percent ? [0, 100] : [0, "auto"]} allowDecimals={false} tick={{ fill: "var(--text-sub)", fontSize: 12, fontFamily: "'DM Mono', monospace" }} axisLine={{ stroke: "var(--border-col)" }} tickLine={false} unit={percent ? "%" : ""} />
                <YAxis
                  type="category" dataKey="org" width={200} interval={0} axisLine={false} tickLine={false}
                  tick={(tp: { x: number; y: number; payload: { value: string } }) => (
                    <text x={tp.x} y={tp.y} dy={4} textAnchor="end" onClick={() => toggleFocus(tp.payload.value)} style={{ cursor: "pointer", fill: dimmed(tp.payload.value) ? "var(--text-dim)" : "var(--text-main)", fontSize: 12.5, fontWeight: focused.has(tp.payload.value) ? 700 : 400, fontFamily: "'DM Mono', monospace" }}>
                      {shortOrg(tp.payload.value)}
                    </text>
                  )}
                />
                <Tooltip content={artTip as never} cursor={{ fill: "rgba(128,128,128,.12)" }} />
                {visible.map((s) => (
                  <Bar key={s} dataKey={s} stackId="a" fill={SCOPE_COLOUR[s]} cursor="pointer" onClick={(d: { org?: string }) => d?.org && toggleFocus(d.org)} isAnimationActive={false}>
                    {artData.map((r) => <Cell key={String(r.org)} fill={SCOPE_COLOUR[s]} fillOpacity={dimmed(String(r.org)) ? 0.22 : 1} />)}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 13, color: dim, padding: "6px 8px 4px" }}>
            {focus.length ? <>Showing {focus.map((o, i) => <span key={o}>{i ? ", " : ""}<strong style={{ color: "var(--text-main)" }}>{o}</strong></span>)}; the other organisations are faded. Click a name or bar again to deselect.</> : "Click an organisation (its name or bar) to focus on it. Hover for the numbers."}
          </div>
        </div>
      </Section>

      <Section
        n={7}
        title="Benchmark table: you against the field"
        note={`Posts by scope, ${platformNote}. Total of all ${rows.length} organisations, the median organisation, and the organisations you pick.`}
        actions={
          <>
            <select
              value="" onChange={(e) => { if (e.target.value) { setFocus((f) => (f.includes(e.target.value) ? f : [...f, e.target.value])); } }}
              style={{ background: "var(--elevate-1)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "6px 10px", color: "var(--text-main)", fontSize: 13.5 }}
            >
              <option value="">Add an organisation…</option>
              {[...ds.orgs].sort((a, b) => a.localeCompare(b)).filter((o) => !focus.includes(o)).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {focus.length > 0 && <button style={chip(false)} onClick={() => setFocus([])}>Clear selection</button>}
            <button style={chip(false)} onClick={csvBenchmark}>⬇ CSV</button>
          </>
        }
      >
        <div style={{ ...card, padding: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 3, fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", color: dim, fontWeight: 600, padding: "4px 8px" }}> </th>
                {benchmark.cols.map((c) => <th key={c} style={{ color: c === "all" ? dim : SCOPE_COLOUR[c], fontWeight: 700, padding: "4px 8px" }}>{colLabel(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: "6px 8px", color: "var(--text-main)", fontWeight: 700 }}>Total (all organisations)</td>
                {benchmark.cols.map((c) => <td key={c} style={{ textAlign: "center", padding: "6px 8px", background: "var(--elevate-2)", borderRadius: 6, color: "var(--text-main)", fontWeight: 700, ...mono }}>{benchmark.total[c]}</td>)}
              </tr>
              <tr>
                <td style={{ padding: "6px 8px", color: "var(--text-main)", fontWeight: 700 }} title="Half of the organisations posted fewer than this, half more">Median organisation</td>
                {benchmark.cols.map((c) => <td key={c} style={{ textAlign: "center", padding: "6px 8px", background: "var(--elevate-2)", borderRadius: 6, color: "var(--text-main)", fontWeight: 700, ...mono }}>{num(benchmark.med[c])}</td>)}
              </tr>
              {benchmark.mine.length === 0 ? (
                <tr><td colSpan={benchmark.cols.length + 1} style={{ padding: "10px 8px", color: dim, fontSize: 13.5 }}>Pick an organisation with “Add an organisation…”, or click one in the chart or the table below, to compare it here.</td></tr>
              ) : benchmark.mine.map((r) => (
                <tr key={r.org}>
                  <td style={{ padding: "6px 8px", color: "var(--accent-amber)", fontWeight: 700 }}>{r.org}</td>
                  {benchmark.cols.map((c) => {
                    const v = benchmark.val(r, c), m = benchmark.med[c];
                    return (
                      <td key={c} title={`${r.org}: ${v} · median ${num(m)} · ${v > m ? "above" : v < m ? "below" : "at"} the median`} style={{ textAlign: "center", padding: "6px 8px", border: "1px solid var(--accent-amber)", borderRadius: 6, color: "var(--text-main)", fontWeight: 700, ...mono }}>
                        {v}<span style={{ color: dim, fontWeight: 400, fontSize: 11.5 }}> {v > m ? "▲" : v < m ? "▼" : "="}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 12.5, color: dim, padding: "8px 8px 2px" }}>▲ above, ▼ below, = equal to the median organisation.</div>
        </div>
      </Section>

      <Section
        n={8}
        title="All organisations (table)"
        note="The numbers behind the chart. Click a column heading to sort by it (again to reverse); click a number to see exactly those posts."
        actions={<button style={chip(false)} onClick={csvAll}>⬇ CSV</button>}
      >
        <div style={{ ...card, padding: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 3, fontSize: 14 }}>
            <thead>
              <tr>
                <th onClick={() => sortBy("name")} style={{ ...th, textAlign: "left", color: sort.key === "name" ? "var(--text-main)" : dim }}>Organisation{arrow("name")}</th>
                {ds.scopes.map((s) => (
                  <th key={s.id} onClick={() => sortBy(s.id)} title={`Sort by ${s.label}`} style={{ ...th, color: SCOPE_COLOUR[s.id], textDecoration: sort.key === s.id ? "underline" : "none" }}>{s.label}{arrow(s.id)}</th>
                ))}
                <th onClick={() => sortBy("all")} title="Sort by all posts" style={{ ...th, color: sort.key === "all" ? "var(--text-main)" : dim }}>All{arrow("all")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.org} style={{ opacity: dimmed(r.org) ? 0.4 : 1 }}>
                  <td onClick={() => toggleFocus(r.org)} style={{ cursor: "pointer", padding: "4px 8px", color: "var(--text-main)", fontWeight: focused.has(r.org) ? 700 : 400, ...mono, fontSize: 13, whiteSpace: "nowrap" }}>{r.org}</td>
                  {scopeIds.map((s) => {
                    const v = r.counts[s];
                    return (
                      <td
                        key={s}
                        title={`${r.org}: ${v} ${labelOf(s)} posts (${pct(v, r.all)} of its ${r.all})`}
                        onClick={() => { setFocus([r.org]); setScopes([s]); setShown(20); }}
                        style={{ cursor: "pointer", textAlign: "center", padding: "5px 8px", borderRadius: 6, color: "var(--text-main)", fontWeight: v ? 700 : 400, ...mono, background: v ? `color-mix(in srgb, ${SCOPE_COLOUR[s]} ${Math.round(12 + 55 * (v / maxCell[s]))}%, transparent)` : "transparent", opacity: v ? 1 : 0.5 }}
                      >{v}</td>
                    );
                  })}
                  <td style={{ textAlign: "center", padding: "5px 8px", color: "var(--text-main)", ...mono }}>{r.all}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section n={9} title="Posts" note={`${list.length} posts in the current view, most engagement first.`}>
        <div style={{ ...card, padding: 16 }}>
          {list.length === 0 ? <div style={{ color: dim }}>No posts match.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.slice(0, shown).map((p, i) => (
                <div key={`${p.u}-${i}`} style={{ borderLeft: `3px solid ${SCOPE_COLOUR[p.s ?? "other"]}`, background: "var(--elevate-2)", borderRadius: "0 8px 8px 0", padding: "8px 12px" }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: dim, ...mono }}>
                    <strong style={{ color: "var(--text-main)" }}>{p.o}</strong>
                    <span>{PLATFORM_LABEL[p.p]}</span>
                    <span style={{ color: SCOPE_COLOUR[p.s ?? "other"], fontWeight: 700 }}>{labelOf(p.s ?? "other")}</span>
                    <span>{fmtDate(p.d)}</span>
                    <span>♥ {p.l} · 💬 {p.c} · ↗ {p.h}{p.v ? ` · 👁 ${p.v}` : ""}</span>
                    {p.u && <a href={p.u} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-amber)" }}>Open ↗</a>}
                  </div>
                  <div style={{ fontSize: 14, color: "var(--text-main)", marginTop: 4, lineHeight: 1.45 }}>{p.t.length > 260 ? `${p.t.slice(0, 260)}…` : p.t || "(no text)"}</div>
                </div>
              ))}
              {list.length > shown && <button style={{ ...chip(false), alignSelf: "flex-start" }} onClick={() => setShown((n) => n + 20)}>Show 20 more</button>}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
