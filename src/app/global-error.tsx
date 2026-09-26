"use client";

/**
 * A crash in the root layout itself (ThemeProvider, AppShell construction, a font loader failure).
 * Next replaces the ENTIRE root layout including <html>/<body> — nothing here can assume Tailwind's
 * token CSS, a self-hosted font, or any provider loaded successfully, since the crash may be exactly
 * one of those things. Inline styles with hard-coded hex values only — a CSS custom property may
 * be exactly what failed to resolve.
 */

const PAPER = "#fdf9f6";
const INK = "#241e1a";
const MUTED = "#5f5651";
const ACCENT = "#006f87";
const ACCENT_FOREGROUND = "#f9fcfe";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ reset }: GlobalErrorProps) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: PAPER,
          color: INK,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "24rem", padding: "1rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 500, margin: "0 0 0.5rem" }}>Something went wrong</h1>
          <p style={{ fontSize: "0.875rem", color: MUTED, margin: "0 0 1rem" }}>
            Something went wrong. Please try again.
          </p>
          {offline && (
            <p style={{ fontSize: "0.875rem", color: MUTED, margin: "0 0 1rem" }}>You appear to be offline.</p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              backgroundColor: ACCENT,
              color: ACCENT_FOREGROUND,
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
