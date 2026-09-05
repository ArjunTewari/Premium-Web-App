import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

export default function Signup() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const [, navigate] = useLocation();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) { setError("Passwords do not match"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Signup failed"); return; }
      await refresh();
      navigate("/");
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg-app)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Space Grotesk', sans-serif",
    }}>
      <div style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-col)",
        borderRadius: 12,
        padding: "2.5rem",
        width: "100%",
        maxWidth: 400,
        boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
      }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🌿</div>
          <h1 style={{ color: "var(--text-main)", fontSize: 28, fontWeight: 700, margin: 0 }}>
            Emerald AI
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 15, marginTop: 4 }}>
            Create your account
          </p>
        </div>

        <form onSubmit={handleSignup}>
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={labelStyle}>Username</label>
            <input
              style={inputStyle}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              minLength={3}
            />
          </div>
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              style={inputStyle}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={6}
            />
          </div>
          <div style={{ marginBottom: "1.5rem" }}>
            <label style={labelStyle}>Confirm Password</label>
            <input
              type="password"
              style={inputStyle}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {error && <p style={errorStyle}>{error}</p>}
          <button type="submit" style={btnStyle} disabled={loading}>
            {loading ? "Creating account…" : "Create Account"}
          </button>
          <p style={{ textAlign: "center", marginTop: 16, color: "var(--text-muted)", fontSize: 15 }}>
            Already have an account?{" "}
            <a
              href="/login"
              onClick={(e) => { e.preventDefault(); navigate("/login"); }}
              style={{ color: "var(--accent-amber)", textDecoration: "none" }}
            >
              Sign in
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
