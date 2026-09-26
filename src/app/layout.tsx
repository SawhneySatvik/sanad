import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { devanagari, literata, plexMono, plexSans, sourceSerif } from "./fonts";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Saboot",
    template: "%s · Saboot",
  },
  description:
    "Saboot explains what a legal document says and shows exactly where it says it, for Indian tenants, employees and freelancers. It never gives legal advice.",
};

// viewport-fit=cover so env(safe-area-inset-*) resolves at all on iOS Safari — the phone bottom
// sheet and pinned composer both need it for their safe-area padding.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes sets the .dark class client-side before first paint,
    // which the server's own markup can never predict — this is next-themes' own documented
    // requirement, not a blanket escape hatch for other mismatches.
    <html
      lang="en"
      className={`${sourceSerif.variable} ${plexSans.variable} ${devanagari.variable} ${literata.variable} ${plexMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
