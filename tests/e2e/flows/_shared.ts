// Shared helpers for the flow specs in this directory only — never imported from tests/e2e/screens
// or tests/e2e/support (those are other lanes' territory). Not a *.spec.ts file itself, so
// no-raw-playwright.spec.ts's static scan (which only walks *.spec.ts) never inspects it; every
// actual spec still imports test/expect from ../support/fixtures, never from here.

import path from "node:path";
import { readFileSync } from "node:fs";

export const FIXTURES_DIR = path.join(process.cwd(), "tests", "fixtures", "documents");

export function isPhoneProject(testInfo: import("@playwright/test").TestInfo): boolean {
  return testInfo.project.name.startsWith("phone");
}

/** The 3-step upload flow driven directly through the API, for a flow that needs a real, owned document without narrating the composer's own attach mechanics (F2's own spec exercises that surface instead). */
export async function uploadRawText(page: import("@playwright/test").Page, filename: string, text: string): Promise<string> {
  const bytes = Buffer.from(text, "utf8");
  const targetResponse = await page.request.post("/api/uploads", { data: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength } });
  if (!targetResponse.ok()) throw new Error(`uploadRawText: POST /api/uploads failed: ${await targetResponse.text()}`);
  const target = (await targetResponse.json()) as { uploadUrl: string; ref: string };
  const relayResponse = await page.request.put(target.uploadUrl, { data: bytes });
  if (!relayResponse.ok()) throw new Error(`uploadRawText: relay PUT failed: ${await relayResponse.text()}`);
  const confirmResponse = await page.request.post("/api/documents", { data: { storageRef: target.ref, filename, mimeType: "text/plain" } });
  if (!confirmResponse.ok()) throw new Error(`uploadRawText: POST /api/documents failed: ${await confirmResponse.text()}`);
  const body = (await confirmResponse.json()) as { document: { id: string } };
  return body.document.id;
}

export async function openLeaseSample(page: import("@playwright/test").Page): Promise<string> {
  const opened = await page.request.post("/api/samples/lease/open");
  if (!opened.ok()) throw new Error(`openLeaseSample: ${await opened.text()}`);
  const body = (await opened.json()) as { documentId: string };
  return body.documentId;
}

/** Findings (and the workspace's own phone-only controls) live inside the phone BottomSheet, never the base view. */
export async function openFindingsIfPhone(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): Promise<void> {
  if (!isPhoneProject(testInfo)) return;
  await page.getByRole("button", { name: /^\d+ findings?$/ }).click();
  await page.getByRole("dialog").waitFor();
}

/** The workspace's Ask segment: an ordinary tab on desktop, behind the phone sheet's own "Ask" trigger on phone. */
export async function openAskPanel(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): Promise<void> {
  if (isPhoneProject(testInfo)) {
    await page.getByRole("button", { name: "Ask" }).click();
    await page.getByRole("dialog").waitFor();
  }
  await page.getByRole("tab", { name: "Ask" }).click();
}

/** The dev sign-in + claim round trip — the product's only stand-in for real auth, refused outside e2e/dev builds. */
export async function devSignIn(page: import("@playwright/test").Page, displayName: string): Promise<void> {
  const signIn = await page.request.post("/api/auth/dev-sign-in", { data: { displayName } });
  if (!signIn.ok()) throw new Error(`devSignIn: ${await signIn.text()}`);
  await page.request.post("/api/auth/claim");
}

export function readFixture(filename: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, filename));
}
