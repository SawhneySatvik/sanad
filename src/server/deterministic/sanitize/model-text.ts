// A model can imitate a trusted badge or reverse nearby text with these characters.
const BADGE_GLYPHS = /[✅✓✔☑🗸🗹√🆗𐄂\ufe0f]/gu;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeModelText(text: string): string {
  return text.replace(BADGE_GLYPHS, "").replace(BIDI_CONTROLS, "");
}
