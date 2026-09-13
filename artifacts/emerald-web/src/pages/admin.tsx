import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

interface ReportLog {
  id: number;
  organizations: string[];
  dateFrom: string;
  dateTo: string;
  htmlName: string | null;
  clientName: string | null;
  generatedBy: string | null;
  costInr: string;
  costSerperInr: string;
  costLlmAeoInr: string;
  costClaudeInr: string;
  costYoutubeInr: string;
  costStorageInr: string;
  costDeploymentInr: string;
  createdAt: string;
}

interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  createdAt: string;
}

interface MonthlyCost {
  month: string;
  count: number;
  totalCostInr: number;
  totalSerper: number;
  totalLlmAeo: number;
  totalClaude: number;
  totalYoutube: number;
  totalStorage: number;
  totalDeployment: number;
}

function fmt(n: string | number) {
  return "₹" + Number(n).toFixed(2);
}

function infraTotal(r: ReportLog) {
  return (
    Number(r.costSerperInr) +
    Number(r.costLlmAeoInr) +
    Number(r.costClaudeInr) +
    Number(r.costYoutubeInr || 0) +
    Number(r.costStorageInr) +
    Number(r.costDeploymentInr)
  );
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
}

export default function Admin() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const [reports, setReports] = useState<ReportLog[]>([]);
  const [months, setMonths] = useState<MonthlyCost[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [resettingUser, setResettingUser] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ username: string; newPassword: string; email: string | null; emailed: boolean } | null>(null);
  useEffect(() => {
    if (user && user.role !== "admin") navigate("/");
  }, [user, navigate]);

  function loadUsers() {
    fetch("/api/admin/users", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setUsers(d.users || []))
      .catch(console.error);
  }

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/reports?limit=200", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/admin/costs", { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([rData, cData]) => {
        setReports(rData.reports || []);
        setMonths(cData.months || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    loadUsers();
  }, []);

  async function handleResetPassword(username: string) {
    if (!confirm(`Reset the password for "${username}"?\n\nThis immediately invalidates their current password. A new one is generated and, if they have an email on file, sent to them.`)) return;
    setResettingUser(username);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/reset-password`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "Reset failed."); return; }
      setResetResult({ username, newPassword: data.newPassword, email: data.email, emailed: data.emailed });
    } catch {
      alert("Network error — please try again.");
    } finally {
      setResettingUser(null);
    }
  }

  const filtered =
    selectedMonth === "all"
      ? reports
      : reports.filter((r) => r.createdAt.startsWith(selectedMonth));

  const thisMonth = months[0];

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", fontFamily: "'Space Grotesk', sans-serif", color: "var(--text-main)" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem 1.5rem" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 28 }}>🌿</span>
            <div>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Admin Panel</h1>
              <p style={{ margin: 0, fontSize: 18, color: "var(--text-muted)" }}>Emerald AI — AQ Intelligence Platform</p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => navigate("/")} style={ghostBtn}>
              ← Platform
            </button>
            <button onClick={handleLogout} style={ghostBtn}>
              Logout
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <>
            {/* Summary Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: "2rem" }}>
              <StatCard
                label="Reports This Month"
                value={String(thisMonth?.count ?? 0)}
                sub="generated"
                accent="var(--accent-green)"
              />
              <StatCard
                label="Customer Revenue"
                value={thisMonth ? fmt(thisMonth.totalCostInr) : "₹0"}
                sub="this month"
                accent="var(--accent-amber)"
              />
              <StatCard
                label="Infra Spend"
                value={
                  thisMonth
                    ? fmt(
                        thisMonth.totalSerper +
                          thisMonth.totalLlmAeo +
                          thisMonth.totalClaude +
                          (thisMonth.totalYoutube || 0) +
                          thisMonth.totalStorage +
                          thisMonth.totalDeployment
                      )
                    : "₹0"
                }
                sub="this month"
                accent="#818cf8"
              />
              <StatCard
                label="Total Reports"
                value={String(reports.length)}
                sub="all time"
                accent="#38bdf8"
              />
            </div>

            {/* Monthly Cost Breakdown */}
            {months.length > 0 && (
              <div style={card}>
                <h2 style={sectionTitle}>Monthly Infra Cost Breakdown</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        {["Month", "Reports", "Serper", "LLM (AEO)", "Claude", "YouTube", "Storage", "Deployment", "Total Infra", "Customer Rev"].map((h) => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {months.map((m) => {
                        const totalInfra =
                          m.totalSerper + m.totalLlmAeo + m.totalClaude + (m.totalYoutube || 0) + m.totalStorage + m.totalDeployment;
                        return (
                          <tr key={m.month} style={{ borderBottom: "1px solid var(--border-col)" }}>
                            <td style={tdStyle}>{monthLabel(m.month)}</td>
                            <td style={{ ...tdStyle, textAlign: "center" }}>{m.count}</td>
                            <td style={tdStyle}>{fmt(m.totalSerper)}</td>
                            <td style={tdStyle}>{fmt(m.totalLlmAeo)}</td>
                            <td style={tdStyle}>{fmt(m.totalClaude)}</td>
                            <td style={{ ...tdStyle, color: "#ff6b6b" }}>{fmt(m.totalYoutube || 0)}</td>
                            <td style={tdStyle}>{fmt(m.totalStorage)}</td>
                            <td style={tdStyle}>{fmt(m.totalDeployment)}</td>
                            <td style={{ ...tdStyle, color: "#818cf8", fontWeight: 600 }}>{fmt(totalInfra)}</td>
                            <td style={{ ...tdStyle, color: "var(--accent-amber)", fontWeight: 600 }}>{fmt(m.totalCostInr)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Report Logs */}
            <div style={card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ ...sectionTitle, marginBottom: 0 }}>Report Logs</h2>
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  style={{
                    background: "var(--bg-app)",
                    border: "1px solid var(--border-col)",
                    borderRadius: 6,
                    color: "var(--text-main)",
                    padding: "6px 10px",
                    fontSize: 15,
                  }}
                >
                  <option value="all">All months</option>
                  {months.map((m) => (
                    <option key={m.month} value={m.month}>
                      {monthLabel(m.month)}
                    </option>
                  ))}
                </select>
              </div>

              {filtered.length === 0 ? (
                <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "2rem" }}>
                  No reports found.
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        {["#", "Generated", "Account", "Client", "Orgs", "Date Range", "Customer Cost", "Infra Cost", "Files", "Details"].map((h) => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <>
                          <tr key={r.id} style={{ borderBottom: expanded === r.id ? "none" : "1px solid var(--border-col)" }}>
                            <td style={{ ...tdStyle, color: "var(--text-muted)" }}>{r.id}</td>
                            <td style={tdStyle}>{new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</td>
                            <td style={{ ...tdStyle, fontWeight: 600, color: "var(--accent-amber)" }}>{r.generatedBy ?? "—"}</td>
                            <td style={tdStyle}>{r.clientName ?? "—"}</td>
                            <td style={tdStyle}>
                              <span style={{ color: "var(--accent-green)", fontWeight: 600 }}>{r.organizations.length}</span>
                              <span style={{ color: "var(--text-muted)", fontSize: 15 }}> orgs</span>
                            </td>
                            <td style={{ ...tdStyle, fontSize: 18 }}>
                              {r.dateFrom} → {r.dateTo}
                            </td>
                            <td style={{ ...tdStyle, color: "var(--accent-amber)", fontWeight: 600 }}>
                              {fmt(r.costInr)}
                            </td>
                            <td style={{ ...tdStyle, color: "#818cf8" }}>
                              {fmt(infraTotal(r))}
                            </td>
                            <td style={tdStyle}>
                              <div style={{ display: "flex", gap: 4 }}>
                                {r.htmlName && (
                                  <a href={`/api/download/${r.htmlName}`} style={filePill("#1e3a5f", "#38bdf8")}>HTML</a>
                                )}
                              </div>
                            </td>
                            <td style={tdStyle}>
                              <button
                                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}
                              >
                                {expanded === r.id ? "▲" : "▼"}
                              </button>
                            </td>
                          </tr>
                          {expanded === r.id && (
                            <tr key={`${r.id}-exp`} style={{ borderBottom: "1px solid var(--border-col)" }}>
                              <td colSpan={10} style={{ padding: "0 12px 16px 12px" }}>
                                <div style={{ background: "var(--bg-app)", borderRadius: 8, padding: "1rem", border: "1px solid var(--border-col)" }}>
                                  <p style={{ color: "var(--text-sub)", fontSize: 18, margin: "0 0 10px 0", fontWeight: 600 }}>
                                    Organizations: {r.organizations.join(", ")}
                                  </p>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
                                    <CostBadge label="Serper API" value={r.costSerperInr} color="#f59e0b" />
                                    <CostBadge label="LLM AEO" value={r.costLlmAeoInr} color="#a78bfa" />
                                    <CostBadge label="Claude API" value={r.costClaudeInr} color="#f472b6" />
                                    <CostBadge label="YouTube API" value={r.costYoutubeInr || "0"} color="#ff6b6b" />
                                    <CostBadge label="Storage" value={r.costStorageInr} color="#34d399" />
                                    <CostBadge label="Deployment" value={r.costDeploymentInr} color="#38bdf8" />
                                    <CostBadge label="Total Infra" value={infraTotal(r).toFixed(2)} color="#818cf8" bold />
                                    <CostBadge label="Customer Cost" value={r.costInr} color="var(--accent-amber)" bold />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* User Accounts */}
            <div style={card}>
              <h2 style={sectionTitle}>User Accounts</h2>
              {users.length === 0 ? (
                <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "2rem" }}>No accounts found.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        {["Username", "Email", "Role", "Created", ""].map((h) => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id} style={{ borderBottom: "1px solid var(--border-col)" }}>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{u.username}</td>
                          <td style={tdStyle}>{u.email ?? "—"}</td>
                          <td style={tdStyle}>{u.role}</td>
                          <td style={tdStyle}>{new Date(u.createdAt).toLocaleDateString("en-IN")}</td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => handleResetPassword(u.username)}
                              disabled={resettingUser === u.username}
                              style={{ ...ghostBtn, fontSize: 14, padding: "5px 10px", cursor: resettingUser === u.username ? "wait" : "pointer" }}
                            >
                              {resettingUser === u.username ? "Resetting…" : "Reset Password"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ margin: "12px 0 0", fontSize: 14, color: "var(--text-dim)" }}>
                There is no self-service password recovery — bcrypt hashes can&apos;t be reversed. Resetting generates a new password, saves it immediately, and emails it to the account if it has an email on file.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Password reset result */}
      {resetResult && (
        <div
          onClick={() => setResetResult(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(5px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 16px" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-col)", borderRadius: 14, padding: "28px", maxWidth: 440, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.55)" }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 18, color: "var(--accent-amber)" }}>Password reset — {resetResult.username}</h3>
            <p style={{ margin: "0 0 6px", fontSize: 15, color: "var(--text-muted)" }}>
              {resetResult.emailed
                ? `Emailed to ${resetResult.email}. It's also shown below in case delivery fails.`
                : resetResult.email
                  ? `Email send was not confirmed — hand this to them directly.`
                  : `No email on file — hand this to them directly.`}
            </p>
            <div style={{ background: "var(--bg-app)", border: "1px solid var(--border-col)", borderRadius: 8, padding: "12px 16px", margin: "14px 0", fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: "var(--text-main)", textAlign: "center", userSelect: "all" }}>
              {resetResult.newPassword}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(resetResult.newPassword).catch(() => {});
                }}
                style={ghostBtn}
              >Copy</button>
              <button
                onClick={() => setResetResult(null)}
                style={{ ...ghostBtn, background: "var(--accent-amber)", color: "#0f1923", border: "none", fontWeight: 600 }}
              >Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border-col)",
      borderRadius: 10,
      padding: "1.25rem",
      borderTop: `3px solid ${accent}`,
    }}>
      <p style={{ margin: "0 0 6px 0", color: "var(--text-muted)", fontSize: 18, textTransform: "uppercase", letterSpacing: 1 }}>{label}</p>
      <p style={{ margin: "0 0 2px 0", color: accent, fontSize: 28, fontWeight: 700 }}>{value}</p>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 18 }}>{sub}</p>
    </div>
  );
}

function CostBadge({ label, value, color, bold }: { label: string; value: string | number; color: string; bold?: boolean }) {
  return (
    <div style={{
      background: "var(--bg-card)",
      border: `1px solid ${color}33`,
      borderRadius: 6,
      padding: "8px 12px",
    }}>
      <p style={{ margin: "0 0 2px 0", color: "var(--text-muted)", fontSize: 15 }}>{label}</p>
      <p style={{ margin: 0, color, fontSize: 17, fontWeight: bold ? 700 : 600 }}>₹{Number(value).toFixed(2)}</p>
    </div>
  );
}

function filePill(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    background: bg,
    color,
    borderRadius: 4,
    padding: "2px 7px",
    fontSize: 15,
    fontWeight: 600,
    textDecoration: "none",
  };
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border-col)",
  borderRadius: 10,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 16px 0",
  fontSize: 17,
  fontWeight: 600,
  color: "var(--text-sub)",
  textTransform: "uppercase",
  letterSpacing: 1,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 15,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  color: "var(--text-dim)",
  fontSize: 15,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  borderBottom: "1px solid var(--border-col)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 10px",
  color: "var(--text-mid)",
  verticalAlign: "middle",
};

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-col)",
  borderRadius: 6,
  color: "var(--text-sub)",
  padding: "7px 14px",
  fontSize: 15,
  cursor: "pointer",
};
