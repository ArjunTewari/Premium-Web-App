import { useState, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

type Stage = "password" | "2fa_required" | "2fa_setup";

export default function Login() {
  const [stage, setStage] = useState<Stage>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const otpRef = useRef<HTMLInputElement>(null);

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
      if (data.status === "2fa_required") {
        setStage("2fa_required");
        setTimeout(() => otpRef.current?.focus(), 100);
      } else if (data.status === "2fa_setup_required") {
        await fetchSetupQR();
        setStage("2fa_setup");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSetupQR() {
    const res = await fetch("/api/auth/totp-setup", { credentials: "include" });
    const data = await res.json();
    setQrDataUrl(data.qrDataUrl);
    setTotpSecret(data.secret);
  }

  async function handleVerifyTotp(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: otp }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Invalid code"); setOtp(""); return; }
      await refresh();
      navigate("/");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmSetup(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/totp-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: otp }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Invalid code"); setOtp(""); return; }
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

        {stage === "password" && (
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
        )}

        {stage === "2fa_required" && (
          <form onSubmit={handleVerifyTotp}>
            <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
              <p style={{ color: "var(--text-sub)", fontSize: 18, margin: 0 }}>
                Enter the 6-digit code from your authenticator app
              </p>
            </div>
            <OtpInput value={otp} onChange={setOtp} inputRef={otpRef} />
            {error && <p style={errorStyle}>{error}</p>}
            <button type="submit" style={btnStyle} disabled={loading || otp.length !== 6}>
              {loading ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              style={{ ...btnStyle, background: "transparent", border: "1px solid var(--text-mid)", marginTop: 8 }}
              onClick={() => { setStage("password"); setOtp(""); setError(""); }}
            >
              ← Back
            </button>
          </form>
        )}

        {stage === "2fa_setup" && (
          <form onSubmit={handleConfirmSetup}>
            <div style={{ marginBottom: "1.25rem" }}>
              <p style={{ color: "var(--accent-amber)", fontWeight: 600, fontSize: 18, margin: "0 0 12px 0" }}>
                Set up Two-Factor Authentication
              </p>
              <p style={{ color: "var(--text-sub)", fontSize: 15, margin: "0 0 16px 0", lineHeight: 1.6 }}>
                Scan this QR code with Google Authenticator, Authy, or any TOTP app:
              </p>
              {qrDataUrl && (
                <div style={{ textAlign: "center", margin: "1rem 0", background: "#fff", borderRadius: 8, padding: 12, display: "inline-block" }}>
                  <img src={qrDataUrl} alt="QR Code" style={{ width: 180, height: 180 }} />
                </div>
              )}
              {totpSecret && (
                <div style={{ background: "var(--bg-app)", border: "1px solid var(--border-col)", borderRadius: 6, padding: "8px 12px", marginTop: 12 }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 15, margin: "0 0 4px 0" }}>Manual entry key:</p>
                  <code style={{ color: "var(--accent-green)", fontSize: 18, letterSpacing: 2 }}>{totpSecret}</code>
                </div>
              )}
            </div>
            <p style={{ color: "var(--text-sub)", fontSize: 15, margin: "0 0 12px 0" }}>
              Then enter the 6-digit code to confirm:
            </p>
            <OtpInput value={otp} onChange={setOtp} />
            {error && <p style={errorStyle}>{error}</p>}
            <button type="submit" style={btnStyle} disabled={loading || otp.length !== 6}>
              {loading ? "Confirming…" : "Enable 2FA & Sign In"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function OtpInput({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const digits = value.padEnd(6, " ").split("");
  const internalRef = inputRef as React.RefObject<HTMLInputElement>;
  return (
    <div
      style={{ position: "relative", display: "flex", gap: 8, justifyContent: "center", marginBottom: "1.25rem", cursor: "text" }}
      onClick={() => internalRef?.current?.focus()}
    >
      {digits.map((d, i) => (
        <div
          key={i}
          style={{
            width: 44,
            height: 52,
            background: "var(--bg-app)",
            border: `2px solid ${d.trim() ? "var(--accent-amber)" : "var(--border-col)"}`,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-main)",
            fontSize: 28,
            fontWeight: 700,
            fontFamily: "monospace",
          }}
        >
          {d.trim()}
        </div>
      ))}
      <input
        ref={internalRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          cursor: "text",
          zIndex: 10,
        }}
        autoFocus
      />
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
