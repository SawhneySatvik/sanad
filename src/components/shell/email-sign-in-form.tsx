"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import { notifySessionChanged } from "@/lib/session/sync";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SessionOutput } from "@/shared/contracts/session";

// Sign-in accepts Supabase's own 6-character floor so older accounts still get in; a new account
// must meet the stricter sign-up rule. Both mirror the server's contracts.
const MIN_PASSWORD_LENGTH = { "sign-in": 6, "sign-up": 8 } as const;

export interface EmailSignInFormProps {
  /** Fires once sign-in (or sign-up) has fully succeeded, guest data already claimed server-side. */
  onSuccess?: () => void;
}

type Mode = "sign-in" | "sign-up";

/**
 * The production email/password form: Supabase Auth over `/api/auth/sign-in` and
 * `/api/auth/sign-up`. Unlike the dev SignInForm, one request does everything — the server claims
 * the caller's guest data itself, so there is no separate client-side claim call to sequence.
 */
export function EmailSignInForm({ onSuccess }: EmailSignInFormProps) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const queryClient = useQueryClient();

  function switchMode() {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      setError("Enter your email to continue.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH[mode]) {
      setError(`Use a password of at least ${MIN_PASSWORD_LENGTH[mode]} characters.`);
      return;
    }
    setError(null);
    setSubmitting(true);

    const path = mode === "sign-in" ? "/api/auth/sign-in" : "/api/auth/sign-up";
    try {
      await apiFetchJson<SessionOutput>(path, { method: "POST", json: { email: trimmedEmail, password } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }

    // Awaited: onSuccess() below typically navigates away immediately, which would otherwise unmount
    // this page's session observer mid-refresh and strand the destination's own fresh observer
    // reading stale, pre-sign-in cache data.
    await notifySessionChanged(queryClient);
    setSubmitting(false);
    onSuccess?.();
  }

  const submitLabel = mode === "sign-in" ? "Sign in" : "Create account";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          autoFocus
          className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          id={passwordId}
          type="password"
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting || email.trim().length === 0 || password.length === 0}>
        {submitting ? (mode === "sign-in" ? "Signing you in…" : "Creating your account…") : submitLabel}
      </Button>
      <button
        type="button"
        onClick={switchMode}
        disabled={submitting}
        className="text-sm text-primary underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-50"
      >
        {mode === "sign-in" ? "Create an account" : "I already have an account"}
      </button>
    </form>
  );
}
