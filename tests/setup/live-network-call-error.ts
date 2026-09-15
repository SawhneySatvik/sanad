// Side-effect-free on purpose: `no-network.ts` is the only place that installs the network guard.
// Keeping this class in its own module means a test can import it WITHOUT re-triggering the guard
// install.
export class LiveNetworkCallError extends Error {
  constructor(url: string) {
    super(
      `LiveNetworkCallError: blocked outbound network call to "${url}". ` +
        `npm test / npm run check-all must never reach a live network host ` +
        `(CLAUDE.md: npm test never calls a live API) — use a fake at the SDK boundary instead.`,
    );
    this.name = "LiveNetworkCallError";
  }
}
