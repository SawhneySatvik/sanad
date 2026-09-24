import type { NextConfig } from "next";
import { securityHeaders } from "./src/server/http/security-headers";

const nextConfig: NextConfig = {
  // PGlite ships a WASM binary that Next's server bundler must not trace or bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository keeps its own agent rules in CLAUDE.md; stop `next dev` from generating
  // AGENTS.md/CLAUDE.md at the root.
  agentRules: false,
  poweredByHeader: false,
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
