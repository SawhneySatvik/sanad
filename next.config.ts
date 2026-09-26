import type { NextConfig } from "next";
import { securityHeaders } from "./src/server/http/security-headers";

const nextConfig: NextConfig = {
  // PGlite ships a WASM binary that Next's server bundler must not trace or bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository keeps its own agent rules in CLAUDE.md; stop `next dev` from generating
  // AGENTS.md/CLAUDE.md at the root.
  agentRules: false,
  poweredByHeader: false,
  experimental: {
    // lucide-react is already on Next's own default optimizePackageImports list — only radix-ui is
    // added here. It is the one client-imported dependency (23 files) shaped like the barrel this
    // option targets: one 1MB entry point re-exporting every Radix primitive as its own submodule,
    // so an unoptimized import pulls every primitive's module graph into a route that uses one of
    // them. cmdk and the rest of package.json's UI dependencies are single small entry points with
    // nothing left to narrow.
    optimizePackageImports: ["radix-ui"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(securityHeaders()).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
