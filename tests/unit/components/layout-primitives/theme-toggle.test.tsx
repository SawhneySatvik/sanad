import { renderToString } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { ThemeProvider } from "next-themes";
import { ThemeToggle } from "@/components/layout-primitives/theme-toggle";

function renderToggle() {
  return render(
    <ThemeProvider attribute="class" enableSystem>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("renders a labelled toggle button", async () => {
    renderToggle();
    expect(await screen.findByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
  });

  it("opens a menu with Light, Dark and System options as a real radio group", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByRole("button", { name: "Toggle theme" }));
    expect(await screen.findByRole("menuitemradio", { name: /Light/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Dark/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /System/ })).toBeInTheDocument();
  });

  it("switches the html element's class when Dark is selected", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByRole("button", { name: "Toggle theme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Dark/ }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
  });

  it("marks the active theme's option checked", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByRole("button", { name: "Toggle theme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Dark/ }));
    await user.click(await screen.findByRole("button", { name: "Toggle theme" }));
    expect(await screen.findByRole("menuitemradio", { name: /Dark/ })).toHaveAttribute("aria-checked", "true");
  });

  it("has no axe violations with the menu closed", async () => {
    const { container } = renderToggle();
    await screen.findByRole("button", { name: "Toggle theme" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with the menu open (the menu renders in a portal outside the render container)", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByRole("button", { name: "Toggle theme" }));
    await screen.findByRole("menuitemradio", { name: /Light/ });
    // Scanning the whole body, not just container, is what actually reaches the portalled menu —
    // "region" is disabled because it flags this isolated fragment for having no surrounding page
    // landmarks, which is a property of this test's harness, not of ThemeToggle itself.
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });

  it("server-renders both icons, Sun dark:hidden and Moon hidden dark:block, regardless of what localStorage says — the CSS class, not React state, picks the visible one", () => {
    // window/localStorage both exist under jsdom (unlike a real Node SSR pass); asserting the
    // markup is identical whether or not localStorage says "dark" is what proves the choice is
    // made by the .dark ancestor class at paint time, never by server-rendered JS state — the
    // bug this replaces server-rendered a mount-gated Sun regardless of the real theme.
    localStorage.setItem("theme", "dark");
    try {
      const html = renderToString(
        <ThemeProvider attribute="class" enableSystem>
          <ThemeToggle />
        </ThemeProvider>,
      );
      // lucide's Sun/Moon icons carry these exact stroke path segments; asserting on them (rather
      // than just "an svg is present") pins which icon each block of markup actually is.
      expect(html).toContain('cx="12" cy="12" r="4"'); // Sun
      expect(html).toMatch(/<svg[^>]*class="[^"]*dark:hidden[^"]*"[^>]*>[\s\S]*?cx="12" cy="12" r="4"/);
      expect(html).toContain("M20.985 12.486a9 9"); // Moon
      expect(html).toMatch(/<svg[^>]*class="[^"]*hidden dark:block[^"]*"[^>]*>[\s\S]*?M20.985 12.486a9 9/);
    } finally {
      localStorage.removeItem("theme");
    }
  });
});
