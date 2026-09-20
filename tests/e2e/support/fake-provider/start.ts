// Entry point for running the fake provider as its own process, spawned by scripts/e2e-server.ts.
// Prints one line once it is actually listening, so the parent can poll for readiness instead of
// guessing a fixed startup delay.

import { startFakeProvider } from "./server";

const port = Number(process.env.SABOOT_E2E_PROVIDER_PORT ?? "4100");

startFakeProvider(port)
  .then((handle) => {
    console.log(`fake-provider: listening on ${handle.url}`);
    const shutdown = () => {
      handle.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((error: unknown) => {
    console.error("fake-provider: failed to start:", error);
    process.exit(1);
  });
