import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { SignInForm } from "@/components/shell/sign-in-form";
import { useSession } from "@/lib/session/use-session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// notifySessionChanged's own refetch (invalidateQueries) only refetches an ACTIVE query — one with
// a mounted observer. In the real app, AppSidebar's own useSession() is always mounted alongside
// this form; this stands in for it so the same refetch actually fires here too.
function SessionProbe() {
  useSession();
  return null;
}

function renderForm(onSuccess = vi.fn()) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProbe />
      <SignInForm onSuccess={onSuccess} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { onSuccess, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // sonner's toast queue lives outside React's tree (its own external store) — unmounting the
  // Toaster doesn't clear it, so a prior test's toast would otherwise still be on screen here.
  toast.dismiss();
});

describe("SignInForm", () => {
  it("disables submit until the field holds a non-empty name — no request fires while empty or whitespace-only", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);
    renderForm();
    // SessionProbe's own mount-time GET /api/session isn't what this assertion is about — only
    // whether typing/clicking below fires a request matters here.
    fetchSpy.mockClear();

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "   ");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "Ada");
    expect(submit).toBeEnabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks a name over 120 characters", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn());
    renderForm();

    await user.type(screen.getByLabelText("Name"), "x".repeat(121));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Keep it under 120 characters.")).toBeInTheDocument();
  });

  it("signs in then claims, in that order, and calls onSuccess", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/auth/dev-sign-in") {
        return jsonResponse(200, { kind: "user", displayName: "Ada", signInAvailable: true, guestTtlHours: 3 });
      }
      if (url === "/api/auth/claim") {
        return jsonResponse(200, { documents: 1, comparisons: 0, drafts: 0 });
      }
      // notifySessionChanged's own invalidateQueries hits this too — a real GET /api/session,
      // through the SessionProbe observer renderForm mounts alongside the form.
      if (url === "/api/session") {
        return jsonResponse(200, { kind: "user", displayName: "Ada", signInAvailable: true, guestTtlHours: 3 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { onSuccess } = renderForm();
    // SessionProbe's own mount-time GET /api/session isn't part of the sign-in sequence this test
    // is pinning the order of.
    await waitFor(() => expect(calls).toEqual(["/api/session"]));
    calls.length = 0;

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    // dev-sign-in, then claim, then notifySessionChanged's own post-clear() session refetch.
    expect(calls).toEqual(["/api/auth/dev-sign-in", "/api/auth/claim", "/api/session"]);
    expect(await screen.findByText(/We found 1 document\(s\)/)).toBeInTheDocument();
  });

  it("shows an all-zero claim as a plain 'Signed in.' toast, never an error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/dev-sign-in") {
          return jsonResponse(200, { kind: "user", signInAvailable: true, guestTtlHours: 3 });
        }
        return jsonResponse(200, { documents: 0, comparisons: 0, drafts: 0 });
      }),
    );
    renderForm();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Signed in.")).toBeInTheDocument();
  });

  it("still resets every tab's session cache and calls onSuccess when claim fails after a successful sign-in", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/auth/dev-sign-in") {
        return jsonResponse(200, { kind: "user", displayName: "Ada", signInAvailable: true, guestTtlHours: 3 });
      }
      if (url === "/api/auth/claim") {
        return jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
      }
      if (url === "/api/session") {
        return jsonResponse(200, { kind: "user", displayName: "Ada", signInAvailable: true, guestTtlHours: 3 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { onSuccess } = renderForm();
    await waitFor(() => expect(calls).toEqual(["/api/session"]));
    calls.length = 0;

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // The sign-in boundary already moved server-side, so the session query still gets reset and
    // refetched even though claim below fails — the toast reports the claim failure, but it never
    // blocks the reset or the inline form error path (submitError stays unset).
    await waitFor(() => expect(calls).toContain("/api/session"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(calls).toContain("/api/auth/claim");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("Enter a name to continue.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows an inline error and re-enables the form on failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } }),
        ),
    );
    renderForm();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("has no axe violations at rest", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SignInForm />
      </QueryClientProvider>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
