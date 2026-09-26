// Extension contract for the screen-capture harness (scripts/capture-screens.ts).
//
// Each screen owns exactly one file here: tests/e2e/support/capture/states/<screen>.ts,
// exporting a `states: StateRegistry`. capture-screens.ts looks a screen's file up by name alone
// (tests/e2e/support/capture/registry.ts), so a new screen adds one file and touches
// nothing else in this directory — a shared screen -> module map here would force every screen
// built at once to edit the same file just to register its own states.
//
// A state is a route plus whatever the fake provider, a sample or a session needs before the
// screenshot is a fair one:
// - `setup` runs once, before navigation — register a scripted fake-provider answer
//   (tests/e2e/support/fake-provider/client.ts's registerScript), open a sample, complete a dev
//   sign-in. It receives the same browser context the navigation reuses, so a sign-in response's
//   cookie is already there when `route` loads.
// - `ready` replaces the harness's default "wait for fonts + network idle" — only a state that
//   needs to be captured mid-something supplies one: hold a stream past its first tokens
//   (waitForHeldRequest), then return WITHOUT releasing it, so the screenshot lands on the held
//   frame, not the finished one.
// - `expectStatus` and `allowPageErrors` exist because "broken" is not the same thing as "an error
//   screen": an app's own not-found page, error boundary and global error boundary are themselves
//   states worth capturing, and they return a non-2xx status or throw on purpose. Every other state
//   leaves both at their default (status must be < 400; no uncaught page error), so a route that is
//   actually broken still fails the run instead of silently landing a screenshot of a crash.
//
// Every one of a state's four captures (desktop/phone x light/dark) resets the fake provider first
// — nothing carries over between them, in this state or the next one in the same run. `setup`
// therefore registers every script it needs on every call, and a hold `ready` leaves unreleased
// (the mid-stream capture above) is cleared by the very next capture's reset, not left to the fake
// provider's own 25s safety timeout.

import type { BrowserContext, Page } from "@playwright/test";

export type ThemeOption = "light" | "dark";

export interface CaptureContext {
  /** Already has the theme's localStorage value primed and the non-local network guard installed. */
  page: Page;
  context: BrowserContext;
  /** The running e2e-mode server's origin — build absolute URLs for a setup fetch/request from this. */
  baseUrl: string;
}

export interface CaptureState {
  /** Path (with leading slash) navigated to once `setup` has run. */
  route: string;
  /** Runs once, before navigation. */
  setup?(ctx: CaptureContext): Promise<void>;
  /** Overrides the default post-navigation readiness wait (fonts + network idle). */
  ready?(ctx: CaptureContext): Promise<void>;
  /**
   * What the navigation response's HTTP status must satisfy, or the run fails: a number for an
   * exact match, a predicate for a range. Default: must be < 400.
   */
  expectStatus?: number | ((status: number) => boolean);
  /**
   * Set true only for a state that throws a client exception on purpose to render an error
   * boundary. Every other state fails the run on an uncaught page error.
   */
  allowPageErrors?: boolean;
}

export type StateRegistry = Record<string, CaptureState>;
