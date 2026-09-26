import Image from "next/image";
import Link from "next/link";
import { ClipboardList, FilePen, Files, FileSearch, GitCompare, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { SkipLink } from "@/components/layout-primitives/skip-link";

const HERO_ALT = "Saboot's document workspace: a lease clause highlighted alongside the exact quote it came from.";

const HOW_IT_WORKS = [
  {
    heading: "Upload, or pick a sample",
    body: "Send in a lease, offer letter, NDA, privacy policy or freelance agreement — or open one of five ready-made samples and skip straight to the findings.",
  },
  {
    heading: "See the proof",
    body: "Every finding is tied to the exact words in your document — checked before it's ever shown as verified, never taken on the model's word.",
  },
  {
    heading: "Ask, compare, prepare, or draft",
    body: "Ask follow-up questions, compare two documents side by side, prepare lawyer-ready questions and a checklist, or draft a reply — all grounded in the same checked text.",
  },
];

const FEATURES = [
  { label: "Analyse", Icon: FileSearch, body: "Findings tied to your document's own words." },
  { label: "Ask", Icon: MessageSquare, body: "Ask follow-up questions about what it says." },
  { label: "Compare", Icon: GitCompare, body: "See what changed between two versions." },
  { label: "Prepare", Icon: ClipboardList, body: "Leave with questions and a checklist for a lawyer." },
  { label: "Draft", Icon: FilePen, body: "Draft a reply grounded in the same checked text." },
  { label: "Library", Icon: Files, body: "Everything you've uploaded, in one place." },
];

/**
 * The cold-visitor landing page: no data fetch, no client JS of its own — every link is a plain
 * navigation to /chat, which does its own session/sample work once it loads.
 */
export function LandingPage() {
  return (
    <>
      <SkipLink targetId="main-content" />
      <header className="flex h-16 items-center justify-between border-b border-border px-4 sm:px-8">
        <Wordmark />
        <Button asChild size="sm">
          <Link href="/chat" prefetch={false}>
            Open Saboot
          </Link>
        </Button>
      </header>

      <main id="main-content" className="mx-auto flex max-w-5xl flex-col gap-20 px-4 py-12 sm:px-8 sm:py-20">
        <section className="grid items-center gap-10 md:grid-cols-2 md:gap-14">
          <div className="flex flex-col gap-6">
            <h1 className="font-display text-3xl leading-tight font-medium tracking-[-0.01em] text-foreground sm:text-4xl">
              Read the document. See exactly where it says so.
            </h1>
            <p className="max-w-[50ch] text-base text-muted-foreground">
              Saboot reads Indian lease, offer letter, NDA, privacy policy and freelance agreements, and explains what
              they say. Every quote it shows you is checked against your own document&rsquo;s exact words before
              it&rsquo;s ever called verified.
            </p>
            <div>
              <Button asChild size="lg">
                <Link href="/chat" prefetch={false}>
                  Try a sample
                </Link>
              </Button>
            </div>
          </div>
          {/* A crop of the real workspace, not a drawn illustration: a highlighted clause beside the
              finding it proves, with the badge the server's verifier produced for it. Two images, not
              a <picture> with prefers-color-scheme: the theme is a user choice held as the .dark class
              on <html>, which can disagree with the OS. unoptimized: the files are already sized for
              this slot, and resizing them would need an image dependency this project doesn't carry. */}
          <div>
            <Image src="/assets/landing/hero-light.png" alt={HERO_ALT} width={1070} height={470} unoptimized priority className="rounded-xl border border-border dark:hidden" />
            <Image
              src="/assets/landing/hero-dark.png"
              alt={HERO_ALT}
              width={1070}
              height={470}
              unoptimized
              className="hidden rounded-xl border border-border dark:block"
            />
          </div>
        </section>

        <section aria-labelledby="how-it-works-heading" className="flex flex-col gap-8">
          <h2 id="how-it-works-heading" className="font-display text-2xl font-medium tracking-[-0.01em] text-foreground">
            How it works
          </h2>
          <ol className="flex flex-col gap-6 sm:flex-row sm:gap-8">
            {HOW_IT_WORKS.map((step, index) => (
              <li key={step.heading} className="flex flex-1 gap-3">
                <span aria-hidden="true" className="font-display text-lg font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-medium text-foreground">{step.heading}</h3>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="features-heading" className="flex flex-col gap-8">
          <h2 id="features-heading" className="font-display text-2xl font-medium tracking-[-0.01em] text-foreground">
            What Saboot does
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2 md:grid-cols-3">
            {FEATURES.map(({ label, Icon, body }) => (
              <li key={label} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
                <Icon aria-hidden="true" className="size-6 text-muted-foreground" strokeWidth={1.75} />
                <h3 className="text-base font-medium text-foreground">{label}</h3>
                <p className="text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="not-legal-advice-heading" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
          <h2 id="not-legal-advice-heading" className="text-lg font-medium text-foreground">
            Not legal advice
          </h2>
          <DisclaimerLine variant="footer" />
        </section>
      </main>

      <footer className="flex h-16 items-center justify-center border-t border-border px-4 sm:px-8">
        <Wordmark />
      </footer>
    </>
  );
}
