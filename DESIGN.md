---
name: Saboot
description: A legal-document assistant that shows exactly where a document says what it says.
colors:
  paper: "oklch(0.985 0.006 70)"
  ink: "oklch(0.24 0.012 55)"
  card: "oklch(0.97 0.008 70)"
  accent: "oklch(0.5 0.11 220)"
  accent-foreground: "oklch(0.99 0.004 220)"
  accent-hover: "oklch(0.44 0.115 220)"
  secondary: "oklch(0.97 0.008 70)"
  muted-foreground: "oklch(0.46 0.014 55)"
  border: "oklch(0.88 0.01 60)"
  destructive: "oklch(0.5 0.16 25)"
  destructive-surface: "oklch(0.95 0.03 25)"
  verified: "oklch(0.44 0.1 152)"
  verified-surface: "oklch(0.95 0.035 152)"
  approximate: "oklch(0.47 0.1 75)"
  approximate-surface: "oklch(0.95 0.04 80)"
  not-found: "oklch(0.4 0.02 55)"
  not-found-surface: "oklch(0.93 0.008 60)"
  mark: "oklch(0.93 0.05 90)"
  mark-pulse: "oklch(0.87 0.075 90)"
  mark-underline: "oklch(0.55 0.11 85)"
typography:
  display:
    fontFamily: "Source Serif 4, IBM Plex Sans Devanagari, serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  reading:
    fontFamily: "Literata, IBM Plex Sans Devanagari, serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "IBM Plex Sans, IBM Plex Sans Devanagari, ui-sans-serif, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans, IBM Plex Sans Devanagari, ui-sans-serif, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
rounded:
  sm: "calc(0.625rem - 4px)"
  md: "calc(0.625rem - 2px)"
  lg: "0.625rem"
  xl: "calc(0.625rem + 4px)"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-foreground}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  verification-badge-verified:
    backgroundColor: "{colors.verified-surface}"
    textColor: "{colors.verified}"
    rounded: "9999px"
  verification-badge-approximate:
    backgroundColor: "{colors.approximate-surface}"
    textColor: "{colors.approximate}"
    rounded: "9999px"
  verification-badge-not-found:
    backgroundColor: "{colors.not-found-surface}"
    textColor: "{colors.not-found}"
    rounded: "9999px"
  finding-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
---

# Design System: Saboot

## Overview

**Creative North Star: "The Proof, Played Straight"**

Saboot uses the familiar shape of an AI document assistant — a sidebar, a document pane, a findings
pane, a composer — and owns exactly one idea: proof.
Every quote a finding, a citation or an answer shows is checked against the user's own uploaded
document at the moment it is displayed, and the interface never implies that checking decoratively.
A colour, an icon or a checkmark shown near a quote is not evidence; only the server's verifier is.

The palette is warm near-monochrome paper and ink, not a tech-neutral grey. One restrained teal
accent is spent on actions, focus and links, never on decoration. Verification has its own quiet
green/amber/charcoal family, reserved to a single component (`VerificationBadge`,
`src/components/verification/verification-badge.tsx`) so nothing else in the system can borrow its
colour to look more certain than it is. The build confirms every rejection named in the brief:
grep across `src/components` and `src/app` turns up no hex or `rgb()` literal outside three
non-UI files (`icon.svg`, `manifest.ts`, `global-error.tsx`, which renders before the app's own CSS
can load) — colour is tokens, not spot values. No AI-magic sparkle, gradient or glow appears
anywhere in `src/components/ui` or `src/components/verification`. Surfaces are flat: `Card` uses a
1px `ring-foreground/10` (`src/components/ui/card.tsx:14`), never a drop shadow; the only
`box-shadow` calls in the build (`select.tsx`, `dropdown-menu.tsx`, `popover.tsx`, `sheet.tsx`) are
on floating overlays that must visually separate from the whole page behind them, not on at-rest
surfaces.

**Key characteristics:**
- Warm paper and ink grounds; one teal accent spent only on actions, focus and links.
- Verification is its own colour family, rendered by exactly one component.
- Hairline borders and a 1px ring instead of shadows; shadows appear only under floating overlays.
- A serif for display, headings and the reading column; a humanist sans for UI chrome; a matching
  Devanagari companion loads on every face so mixed-script text never drops to a system font.
- Ease-out motion under 300ms, at most 8px of travel, fully stopped under reduced motion.

## Colors

The palette groups into one primary accent, a verification family that never lends its colour
elsewhere, and a warm neutral scale for paper, ink and structure. Tokens are defined once in
`src/app/globals.css` for light (`:root`) and dark (`.dark`), and consumed everywhere through
Tailwind's `@theme inline` colour names (`bg-card`, `text-verified`, etc.) — no component defines
its own colour value.

### Primary
- **Restrained Teal** (`oklch(0.5 0.11 220)`, `--primary`): the one brand accent — primary buttons,
  links, the focus ring (`--ring` is the same value), and nothing else. Its foreground pairs at
  5.48:1 against `oklch(0.99 0.004 220)` (computed for this document). Dark mode lifts it to
  `oklch(0.72 0.1 220)` at 8.05:1 against its own foreground.

### Verification (its own family, never reused)
- **Verified Green** (`oklch(0.44 0.1 152)` on `oklch(0.95 0.035 152)` surface, 6.48:1): the sole
  colour of a `verified` status.
- **Approximate Amber** (`oklch(0.47 0.1 75)` on `oklch(0.95 0.04 80)` surface, 6.00:1): a close but
  inexact match.
- **Not-Found Charcoal** (`oklch(0.4 0.02 55)` on `oklch(0.93 0.008 60)` surface, 7.53:1): a
  deliberately unalarming, near-neutral tone — the code comment at
  `src/components/verification/verification-badge.tsx:19` records that this status is never given
  a red/error treatment ("not found," never "error"), so a missing clause does not read as a system
  fault.
- **Mark / Mark-Pulse / Mark-Underline** (`oklch(0.93 0.05 90)`, `oklch(0.87 0.075 90)`,
  `oklch(0.55 0.11 85)`): the in-document highlight family, kept structurally separate from
  `--verified` (`src/components/document/highlight-mark.tsx:25`) so a `<mark>` can never be mistaken
  for a second, unaudited verification renderer. `--mark-underline` against paper measures 4.69:1;
  the wash alone is documented in `globals.css:50` as failing 3:1, which is why every highlight
  carries the underline as its real, non-colour cue.

### Neutral
- **Warm Paper** (`oklch(0.985 0.006 70)`, `--background`): the page ground in light mode.
- **Warm Near-Black Ink** (`oklch(0.24 0.012 55)`, `--foreground`): body text, 15.78:1 on paper.
- **Card Wash** (`oklch(0.97 0.008 70)`, `--card`): finding cards, popovers, the sidebar surface.
- **Muted Foreground** (`oklch(0.46 0.014 55)`): secondary text, 6.85:1 on paper — passes for body
  copy. `--muted-faint` (`oklch(0.62 0.012 55)`) is explicitly reserved for large text/graphics only
  (`globals.css:25`) and is never used for a badge label or body copy.
- **Hairline Border** (`oklch(0.88 0.01 60)`): 1.38:1 against paper — intentionally low, because a
  border's job is separation, not text-level legibility.
- **Warm Charcoal** (dark `--background`, `oklch(0.19 0.008 55)`): the dark ground, never a cool or
  pure black.

### Named Rules
**The One Verifier Rule.** No component other than `VerificationBadge` may render a check-mark
icon, the word "Verified," or any status-derived colour tied to `verification.status`. The status
comes only from the server's `verify()` output, never from model text — a `claimedQuote` reading
"[VERIFIED]" is rendered as plain text and produces no badge (enforced structurally: `STATUS_META`
is keyed by `verification.status`, never by content).

**The Borrowed Colour Never Rule.** `--verified`, `--approximate` and `--not-found` are used
exclusively inside `verification-badge.tsx`. `--mark`/`--mark-pulse` are used exclusively inside
`highlight-mark.tsx`. A future component that wants to look "confirmed" reaches for `--verified`
only by going through the badge itself, never by reading the token directly.

## Typography

**Display / heading face:** Source Serif 4 (`src/app/fonts.ts:8`), falling back to IBM Plex Sans
Devanagari, then serif.
**UI face:** IBM Plex Sans, weights 400/500/600/700, with an `latin-ext` subset preloaded because it
renders currency figures on first paint (`fonts.ts:1-4`).
**Reading face:** Literata, for the quoted passage inside `QuoteBlock` and the document column.
**Devanagari companion:** IBM Plex Sans Devanagari, loaded but not preloaded (`preload: false`,
`fonts.ts:26`) since it is only fetched once Devanagari text actually appears — every stack falls
back to it before a generic sans/serif, so mixed English/Hindi text never drops to the system font
mid-sentence.
**Mono face:** IBM Plex Mono, for correlation IDs and hashes only (`error-state.tsx:47`), never
currency.

**Character:** an editorial serif carries the document's own authority (titles, headings); a plain
humanist sans runs the interface around it, so the chrome never competes with the document being
read.

### Hierarchy
- **Display** (font-medium, 1.5rem / `text-2xl`, `PageHeader`'s `<h1>`, `page-header.tsx:26`): one
  page-header shape for every top-level screen.
- **Reading** (400, 0.875rem, line-height 1.6, `font-reading`): the document column and
  `QuoteBlock`'s quoted passage.
- **Body** (400, 0.875rem, `font-sans`): finding explanations, notices, chat text.
- **Label** (500, 0.75rem, `text-xs font-medium`): badge and chip text — `AiLabel`,
  `VerificationBadge`.
- **Mono** (0.8125rem, `font-mono`): a correlation ID inside `ErrorState`'s collapsed `<details>`.

### Named Rules
**The Reading-Face Rule.** Any text that is a quotation of the user's own document — the document
column, `QuoteBlock`'s span, `CitationChip`'s preview — is set in `font-reading` (Literata), never
the UI sans. It marks quoted text as belonging to the source, not to the app's own voice.

## Layout

Desktop (≥1440px reference): a three-region shell. A collapsible sidebar (264px expanded / 56px
collapsed rail, `app-shell.tsx:23-26`) holds new-chat, recents, projects. The centre is the document
as a readable column against a warm-paper card. The right pane defaults to 420px (min 320 / max 560,
`resizable-split.tsx:93`) against a document column with its own 420px floor
(`resizable-split.tsx:86`) — the split is user-resizable, not fixed. The right pane stacks a header
(title, type, "Viewing as"), category-grouped findings, and an Ask composer pinned to the pane's
bottom edge.

At 390px (phone): the document fills the width; findings and Ask move into a bottom sheet reached
by two tabs ("N findings" / "Ask"), and the composer stays pinned above the safe-area inset
(`ask-composer.tsx:37`, `env(safe-area-inset-bottom)`).

Spacing is a tight rhythm: `gap-1`/`gap-2` (4px/8px) inside a component, `p-3` (12px) card padding,
`gap-4`+`p-6` (16/24px) at the page-region scale. `--card-spacing` is 16px by default, 12px for the
`size="sm"` card variant (`card.tsx:14`).

## Elevation & Depth

Flat by default. No component in `src/components/ui` or the verification/document/workspace trees
applies a shadow to an at-rest surface — `Card` and `FindingCard` are bordered/ringed, not lifted
(`card.tsx:14`, `finding-card.tsx:46`). The only `box-shadow` declarations in the build
(`select.tsx:71`, `dropdown-menu.tsx:45,246`, `popover.tsx:32`, `sheet.tsx:74`) belong to floating,
dismissible overlays — content that must read as detached from the page behind it — and even there
a 1px `ring-foreground/10` rides alongside the shadow rather than replacing the hairline entirely.
`sidebar.tsx:477` uses a `shadow-[0_0_0_1px_var(--sidebar-border)]` — a one-pixel outline expressed
as a shadow value, not a true drop shadow; it never grows past 1px on any state.

### Named Rules
**The Hairline-Over-Lift Rule.** Depth on an at-rest surface is a 1px border or ring, never a blur
radius. A shadow is reserved for content that has left the page's own stacking context (a popover, a
sheet, a dropdown).

## Shapes

Radius is a single scale anchored at `--radius: 0.625rem` (10px), stepped down to `sm`
(`calc(radius - 4px)` ≈ 6px) and up to `xl` (≈14px) — `globals.css:8,155-158`. Cards and finding
cards use `rounded-lg`/`rounded-xl`; badges and chips are fully rounded pills (`rounded-4xl` /
`rounded-full`) so the verification family and citation chips read as small, discrete tokens rather
than boxes. `HighlightMark` uses a near-zero `rounded-[1px]` (`highlight-mark.tsx:49`) — the
document's own text should not visibly round at all; the highlight is a wash and an underline, not a
chip. `--input` and `--border` carry hairline borders (1px) everywhere; no component uses a border
heavier than 2px (`current` finding state, `border-b-2`, `highlight-mark.tsx:52`).

## Components

### VerificationBadge (the sole status renderer)
The only component permitted to render a verified/approximate/not-found status
(`verification-badge.tsx:26-34`). Driven solely by `verification.status`, structurally unforgeable
by model text. Every status carries its own icon (`BadgeCheck`, `CircleDashed`, `SearchX`) and label
— colour is never the only cue (WCAG 1.4.1). Icons are deliberately chosen to avoid alarm language:
`approximate` never borrows verified's solid check, `not_found` never uses an error/warning glyph.

### QuoteBlock
The quoted passage: `spanText` for verified/approximate, the labelled `claimedQuote` for
approximate/not-found — plain text only, never `dangerouslySetInnerHTML`
(`quote-block.tsx:20-24`). Set in `font-reading`, with a `border-l-2 border-mark-underline` rule
matching the highlight it points at in the document. Wraps its own text in `<bdi>` with a bidi
isolation style so a hostile bidi control character in the source text cannot reorder the block's
own siblings.

### HighlightMark: rest / current / active
Three independent states, not one toggle (`highlight-mark.tsx:32-58`):
- **rest** — underline only (`border-b border-mark-underline`), no background wash. With every
  finding washed at once none would read as "the one you picked," so rest carries no wash at all.
- **current** — a persistent `bg-mark-pulse` wash plus a heavier `border-b-2`, the reader's
  standing "this is the selected finding" state.
- **active** — a transient `ring-2 ring-mark-underline` flash on top of `current`, marking "just
  jumped here," distinct from having been selected for a while.
`tone="approximate"` renders a dashed underline instead of solid — a shape difference, not only a
colour difference, for the one case where the highlighted span is not an exact match.

### CitationChip
An inline citation inside an assistant message: a chip button (jump-to-span) with a sibling info
button (verification meaning), never nested — a button-in-button is invalid HTML and unreachable as
two controls to assistive tech (`citation-chip.tsx:17-22`). Both controls keep a 44×44px hit area
via an absolutely-positioned pseudo-element grown from a visually smaller box, satisfying WCAG 2.5.8
without inflating the chip's visible size. The preview text is always derived from the citation's own
verification (`spanText` or `claimedQuote`), never accepted as a separate prop, so the chip can never
show text the server did not check.

### FindingCard actions
An `<article>`, never a whole-card `<button>` — three independently reachable controls ("Show in
document," "Test this quote," the badge's info button) instead of nested interactive content
(`finding-card.tsx:1-8`). Both actions share one small outline-button treatment
(`variant="outline" size="sm"`) deliberately: an earlier version styled them asymmetrically (one
accent-link, one muted), which read as if one action were disabled.

### PageHeader
One `<h1>` shape and position for every top-level screen (`page-header.tsx:19-34`), forwarding its
ref so a route can focus its own heading on entry (Compare does this). `font-display text-2xl
font-medium`, an optional muted description line, and a right-aligned actions slot.

### The composer
`AskComposer` (`ask-composer.tsx`) pins to the bottom of the right pane / bottom sheet: a
single-row `Textarea` (min-height 44px) plus a `size="icon"` send button (44px, `size-11`), Enter to
send / Shift+Enter for a newline, and `DisclaimerLine` rendered exactly once beneath it. Sending
alone disables while a reply streams; the field itself stays typable so the next turn can be
composed without losing focus.

### Notices and error states
`InlineNotice` (`inline-notice.tsx`) is the one persistent banner for non-blocking information
outside the verified/approximate/not-found family — an `Info` or `TriangleAlert` icon plus text
inside `role="note"`, announced once on mount via a polite live region. `ErrorState`
(`error-state.tsx:36-51`) is the reusable full-region failure: the server's own fixed per-code
message, a retry button when the failure is retryable, and a collapsed `<details>` correlation ID in
`font-mono` for support — never a raw stack trace.

## Motion and reduced motion

Ease-out cubic-bezier(0.16,1,0.3,1), at most 8px of travel, 300ms or less, no bounce
(`sheet.tsx`, `highlight-mark.tsx:50`). Under `prefers-reduced-motion: reduce`, every animation and
transition collapses to 0.01ms rather than `display:none` or `animation:none`, so a component
listening for `transitionend`/`animationend` still receives a completion signal
(`globals.css:206-223`). The sheet's own slower `motion-reduce:duration-150` is deliberately still
non-zero — reduced, not deleted. Three components manage their own reduced-motion behaviour outside
that global rule by setting `animation-name`/`transition-property: none` directly:
`HighlightMark`'s pulse, the streaming preview, and the upload progress indicator.

## Accessibility commitments

- **WCAG 1.4.1 (Use of Color):** every verification status carries its own icon and label text;
  `tone` colours the badge but is never the sole cue (`verification-badge.tsx:33`). Highlight tones
  differ by underline style (solid/dashed), not colour alone (`highlight-mark.tsx:28`).
- **WCAG 2.3.3 (Animation from Interactions):** `prefers-reduced-motion: reduce` collapses all
  animation/transition durations globally (`globals.css:216-223`).
- **WCAG 2.4.7 (Focus Visible):** a global `:focus-visible` outline using `--ring`
  (`globals.css:201-204`); most components replace it with their own
  `focus-visible:ring-*` treatment rather than stacking both.
- **WCAG 2.5.8 (Target Size Minimum):** a `pointer-coarse:before` pseudo-element grows every
  button's hit area to 44×44px without inflating its visible box (`button.tsx:9-11`); `CitationChip`
  applies the same pattern by hand for its two sibling controls (`citation-chip.tsx:17-23`).
- **1.4.11 (Non-text Contrast) via the Hairline-Over-Lift rule:** `--mark-underline` measures 4.69:1
  against paper (computed for this document), well past the 3:1 floor for a UI-boundary indicator,
  because the wash alone falls short (`globals.css:50`).

## Voice and copy rules

Calm and precise: **"Saboot explains documents. It isn't legal advice."**
(`src/shared/copy/legal-advice.ts`) is the fixed short disclaimer under every composer and in the
app footer (`disclaimer-line.tsx`) — the exact wording is pinned in one place so no surface can
quietly reword it. `AiLabel` (`ai-label.tsx`) discloses "AI-generated" vs "Fixed text" vs a general-
mode label with fixed literal copy, never a per-screen paraphrase, and never carries the legal-advice
line itself — that is `DisclaimerLine`'s job alone. Findings, compare changes and draft sections
carry categories, never a severity score or priority ranking (`docs/PRODUCT.md`, "Information, not
advice"). A missing clause is reported as a gap, never silently omitted or shown as "no issues
found."
