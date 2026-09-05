import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const [, navigate] = useLocation();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Login failed"); return; }
      await refresh();
      navigate("/");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-col)",
          borderRadius: 12,
          padding: "2.5rem",
          width: "100%",
          maxWidth: 400,
          boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🌿</div>
          <h1 style={{ color: "var(--text-main)", fontSize: 28, fontWeight: 700, margin: 0 }}>
            Emerald AI
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 15, marginTop: 4 }}>
            AQ Intelligence Platform
          </p>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={labelStyle}>Username</label>
            <input
              style={inputStyle}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div style={{ marginBottom: "1.5rem" }}>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              style={inputStyle}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p style={errorStyle}>{error}</p>}
          <button type="submit" style={btnStyle} disabled={loading}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
          <p style={{ textAlign: "center", marginTop: 16, color: "var(--text-muted)", fontSize: 15 }}>
            Don't have an account?{" "}
            <a
              href="/signup"
              onClick={(e) => { e.preventDefault(); navigate("/signup"); }}
              style={{ color: "var(--accent-amber)", textDecoration: "none" }}
            >
              Sign up
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "var(--text-sub)",
  fontSize: 15,
  marginBottom: 6,
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-app)",
  border: "1px solid var(--border-col)",
  borderRadius: 8,
  padding: "10px 14px",
  color: "var(--text-main)",
  fontSize: 18,
  outline: "none",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--accent-amber)",
  border: "none",
  borderRadius: 8,
  padding: "11px 0",
  color: "#fff",
  fontSize: 17,
  fontWeight: 600,
  cursor: "pointer",
  display: "block",
};

const errorStyle: React.CSSProperties = {
  color: "#f87171",
  fontSize: 15,
  marginBottom: 12,
  textAlign: "center",
};
