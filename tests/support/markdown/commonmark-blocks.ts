// A block-structure detector written from CommonMark's rules, independently of any renderer under
// test. A line ends at "\n", "\r\n" or a lone "\r". Strip block-quote markers, list markers and up
// to three spaces of indentation; then a line is an ATX heading if it starts with 1-6 unescaped "#"
// followed by a space, tab or line end, a setext underline if it is only "=" or only "-" and follows
// a non-blank line, and a fence opener if it starts with three backticks or tildes.

const CONTAINER_PREFIX = /^(?:[ \t]*>|[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t]))*[ \t]{0,3}/;

function linesOf(markdown: string): string[] {
  return markdown.split(/\r\n?|\n/);
}

function blockText(line: string): string {
  return line.replace(CONTAINER_PREFIX, "");
}

/** Every heading in `markdown`: "## Text" for an ATX heading, "setext: Text" for a setext one. */
export function headingsIn(markdown: string): string[] {
  const lines = linesOf(markdown);
  const headings: string[] = [];
  lines.forEach((line, i) => {
    const text = blockText(line);
    const atx = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(text);
    if (atx) headings.push(`${atx[1]} ${atx[2] ?? ""}`.trim());
    const previous = i > 0 ? blockText(lines[i - 1]).trim() : "";
    if (/^(?:=+|-+)[ \t]*$/.test(text) && previous !== "") headings.push(`setext: ${previous}`);
  });
  return headings;
}

/** Every line of `markdown` that opens a fenced code block. */
export function fenceOpeners(markdown: string): string[] {
  return linesOf(markdown).filter((line) => /^(?:`{3,}|~{3,})/.test(blockText(line)));
}
