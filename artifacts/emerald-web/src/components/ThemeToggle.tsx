import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = resolvedTheme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        width: 46,
        height: 46,
        borderRadius: "50%",
        background: "var(--bg-card)",
        border: "1px solid var(--border-col)",
        color: "var(--text-sub)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        zIndex: 9999,
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        transition: "background 0.2s, color 0.2s, border-color 0.2s",
      }}
    >
      {isDark ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}
