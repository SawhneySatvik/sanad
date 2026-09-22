import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest by Next's own file convention. Icon paths point at public/icons/
// — the PWA icon set's own location, kept apart from the commissioned raster art delivered under
// public/assets/.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Saboot",
    short_name: "Saboot",
    description: "Saboot explains what a legal document says and shows exactly where it says it. It never gives legal advice.",
    start_url: "/",
    display: "standalone",
    background_color: "#fdf9f6",
    theme_color: "#fdf9f6",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
