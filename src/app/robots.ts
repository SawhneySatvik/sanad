import type { MetadataRoute } from "next";

// Served at /robots.txt by Next's own file convention. /api/ is disallowed: every route under it
// is either a JSON endpoint or a dev/e2e-only surface, never a page worth a crawler's time.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
  };
}
