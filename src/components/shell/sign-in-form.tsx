"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import { notifySessionChanged } from "@/lib/session/sync";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ClaimResultOutput } from "@/shared/contracts/claim";
import type { SessionOutput } from "@/shared/contracts/session";

const MAX_DISPLAY_NAME_LENGTH = 120;

export interface SignInFormProps {
  /** Fires once sign-in itself has succeeded. A claim failure afterward is reported as a toast, not
   * a blocking error — the user is signed in either way, so this still fires. */
  onSuccess?: () => void;
}

function claimToastMessage(result: ClaimResultOutput): string {
  const parts: string[] = [];
  if (result.documents > 0) parts.push(`${result.documents} document(s)`);
  if (result.comparisons > 0) parts.push(`${result.comparisons} comparison(s)`);
  if (result.drafts > 0) parts.push(`${result.drafts} draft(s)`);
  if (parts.length === 0) return "Signed in.";
  return `Welcome back. We found ${parts.join(", ")} from your session and saved them to your account.`;
}

/** The dev sign-in form — a dev convenience, never a real auth UI. */
export function SignInForm({ onSuccess }: SignInFormProps) {
  const [displayName, setDisplayName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fieldId = useId();
  const queryClient = useQueryClient();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      setValidationError("Enter a name to continue.");
      return;
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      setValidationError("Keep it under 120 characters.");
      return;
    }
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);

    try {
      await apiFetchJson<SessionOutput>("/api/auth/dev-sign-in", { method: "POST", json: { displayName: trimmed } });
    } catch (err) {
      // ApiError's own message is already the canonical, per-code copy (src/lib/api/error.ts) — no
      // second derivation needed here.
      setSubmitError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }

    try {
      // The inline response is never trusted — the session query is the one source of truth,
      // refetched fresh by notifySessionChanged below.
      const claimResult = await apiFetchJson<ClaimResultOutput>("/api/auth/claim", { method: "POST" });
      // Awaited: onSuccess() below typically navigates away immediately, which would otherwise
      // unmount this page's session observer mid-refresh and strand the destination's own fresh
      // observer reading stale, pre-claim cache data.
      await notifySessionChanged(queryClient);
      toast.success(claimToastMessage(claimResult));
    } catch (err) {
      // Sign-in itself already succeeded server-side — a claim failure is reported, not treated as
      // a blocking form error, and the cross-tab reset still has to run regardless: every open tab
      // (this one included) needs to reflect the new, now-signed-in session whether or not the
      // guest's own data made it across too.
      await notifySessionChanged(queryClient);
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
    onSuccess?.();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Name</Label>
        <Input
          id={fieldId}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          autoFocus
          // The base Input's own focus ring is a 3px box-shadow — heavier than the app's usual 2px,
          // 2px-offset floor, and jarring on a field that grabs focus the instant this screen mounts.
          className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-invalid={Boolean(validationError)}
          aria-describedby={validationError ? `${fieldId}-error` : undefined}
        />
        {validationError && (
          <p id={`${fieldId}-error`} className="text-sm text-destructive">
            {validationError}
          </p>
        )}
      </div>
      {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      <Button type="submit" disabled={submitting || displayName.trim().length === 0}>
        {submitting ? "Signing you in…" : "Sign in"}
      </Button>
    </form>
  );
}
