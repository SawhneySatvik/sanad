import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmailSignInForm } from "@/components/shell/email-sign-in-form";
import { useSession } from "@/lib/session/use-session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// notifySessionChanged's own refetch (invalidateQueries) only refetches an ACTIVE query — this
// stands in for the sidebar's own mounted useSession() observer.
function SessionProbe() {
  useSession();
  return null;
}

function renderForm(onSuccess = vi.fn()) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProbe />
      <EmailSignInForm onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmailSignInForm", () => {
  it("defaults to sign-in mode: labels, autocomplete, and a disabled submit until both fields are filled", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn());
    renderForm();

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");

    await user.type(email, "asha@example.com");
    expect(submit).toBeDisabled();
    await user.type(password, "correct horse battery staple");
    expect(submit).toBeEnabled();
  });

  it("toggling to 'Create an account' switches the submit label, the password autocomplete, and calls /api/auth/sign-up", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "/api/auth/sign-up") return jsonResponse(200, { kind: "user", displayName: "asha", signInAvailable: true, guestTtlHours: 3, signInMethod: "email" });
        if (url === "/api/session") return jsonResponse(200, { kind: "user", displayName: "asha", signInAvailable: true, guestTtlHours: 3, signInMethod: "email" });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { onSuccess } = renderForm();
    await waitFor(() => expect(calls).toEqual(["/api/session"]));
    calls.length = 0;

    await user.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");

    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(calls).toContain("/api/auth/sign-up");
  });

  it("shows a rejected sign-in's server message in an alert tied to the fields, and re-enables the form", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      // A fresh Response per call — a shared mockResolvedValue instance would have its body
      // consumed once (by SessionProbe's own GET /api/session) and read as empty the second time.
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } })),
    );
    renderForm();

    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email or password is incorrect.");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-describedby", alert.id);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("disables the submit button while the request is pending", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    renderForm();

    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Signing you in…" })).toBeDisabled();
    resolveFetch(jsonResponse(200, { kind: "user", signInAvailable: true, guestTtlHours: 3, signInMethod: "email" }));
  });

  it("rejects a too-short password before ever sending a request: 6 characters to sign in, 8 to create an account", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    renderForm();
    fetchSpy.mockClear();

    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/at least 6 characters/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /create an account/i }));
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "seven77");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no axe violations at rest", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailSignInForm />
      </QueryClientProvider>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
