import { deflateSync } from "node:zlib";

// Test-only helper — builds minimal, valid-enough PDF buffers in memory so adversarial/edge-case
// PDFs (page-count bombs, many-image-page documents, short-but-real single-page documents) never
// need to be committed as binary fixtures. Not imported by any production code.

function escapePdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const MAX_CHARS_PER_LINE = 80;
const LINE_HEIGHT = 14;

// Real PDF producers wrap prose into multiple lines, and pdf.js's text extraction stops partway
// through a single unwrapped line once it runs past the page's visible width — so this builder
// wraps too, rather than emitting one long `Tj` string per page.
function wrapToLines(text: string, maxCharsPerLine = MAX_CHARS_PER_LINE): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// A `BT ... ET` text object with one `Tj` per wrapped line, each line
// positioned via a relative `Td` move (so this stays correct regardless of
// how many lines there are, without pre-computing absolute Y coordinates).
function buildTextContentStream(text: string, startX = 20, startY = 700): string {
  const lines = wrapToLines(text);
  let ops = `BT /F1 12 Tf ${startX} ${startY} Td\n`;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) ops += `0 -${LINE_HEIGHT} Td\n`;
    ops += `(${escapePdfString(lines[i])}) Tj\n`;
  }
  ops += "ET";
  return ops;
}

function obj(num: number, dict: string): string {
  return `${num} 0 obj\n${dict}\nendobj\n`;
}

function streamObj(num: number, dict: string, content: string): string {
  return `${num} 0 obj\n${dict}\nstream\n${content}\nendstream\nendobj\n`;
}

// One page per string in `pageTexts`.
export function buildTextPdf(pageTexts: string[]): Buffer {
  const CATALOG = 1;
  const PAGES = 2;
  const numPages = pageTexts.length;
  const kids: string[] = [];
  for (let i = 0; i < numPages; i++) kids.push(`${3 + i * 2} 0 R`);

  const parts: string[] = [];
  parts.push(obj(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`));
  parts.push(obj(PAGES, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${numPages} >>`));

  let nextObjNum = 3;
  const fontObjNum = 3 + numPages * 2;
  for (let i = 0; i < numPages; i++) {
    const pageObjNum = nextObjNum++;
    const contentObjNum = nextObjNum++;
    const content = buildTextContentStream(pageTexts[i]);
    parts.push(
      obj(
        pageObjNum,
        `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`,
      ),
    );
    parts.push(streamObj(contentObjNum, `<< /Length ${Buffer.byteLength(content, "latin1")} >>`, content));
  }
  parts.push(obj(fontObjNum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`));

  // Deliberately no real xref table (`startxref 0`, no `xref` section) — pdf.js falls back to its
  // own "scan the file for `N M obj` markers and rebuild the xref" recovery path, which real
  // producers' "messy" PDFs rely on too, so this keeps the builder simple without losing realism.
  let body = "%PDF-1.4\n" + parts.join("");
  body += `trailer\n<< /Size ${fontObjNum + 1} /Root ${CATALOG} 0 R >>\n`;
  body += `startxref\n0\n%%EOF`;
  return Buffer.from(body, "latin1");
}

// `numPages` pages, all sharing ONE small content stream — models a real
// page-count-bomb shape (thousands of /Page objects, tiny file size, no
// content-stream duplication cost) rather than a large-single-page bomb.
export function buildManyPagePdf(numPages: number, pageContent = "Hi"): Buffer {
  const CATALOG = 1;
  const PAGES = 2;
  const CONTENT = 3;
  const FONT = 5;

  const kids: string[] = [];
  for (let i = 0; i < numPages; i++) kids.push(`${4 + i} 0 R`);

  const parts: string[] = [];
  parts.push(obj(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`));
  parts.push(obj(PAGES, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${numPages} >>`));
  const content = buildTextContentStream(pageContent, 10, 100);
  parts.push(streamObj(CONTENT, `<< /Length ${Buffer.byteLength(content, "latin1")} >>`, content));
  for (let i = 0; i < numPages; i++) {
    parts.push(
      obj(
        4 + i,
        `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 200 200] /Contents ${CONTENT} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`,
      ),
    );
  }
  parts.push(obj(FONT, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`));

  let body = "%PDF-1.4\n" + parts.join("");
  body += `trailer\n<< /Size ${numPages + 5} /Root ${CATALOG} 0 R >>\n`;
  body += `startxref\n0\n%%EOF`;
  return Buffer.from(body, "latin1");
}

// Builds a document from an ordered mix of pages, each either `{ kind: "text"; text: string }` or
// `{ kind: "image" }` (no extractable text — a minimal 1x1 image XObject with no text-show
// operators), for "typed cover page + image-only pages" style tests.
export function buildMixedPagesPdf(
  pages: Array<{ kind: "text"; text: string } | { kind: "image" }>,
): Buffer {
  const CATALOG = 1;
  const PAGES = 2;
  const FONT = 3;

  let nextObjNum = 4;
  const pageObjNums: number[] = [];
  const bodyParts: string[] = [];

  for (const page of pages) {
    const pageObjNum = nextObjNum++;
    pageObjNums.push(pageObjNum);

    if (page.kind === "text") {
      const contentObjNum = nextObjNum++;
      const content = buildTextContentStream(page.text);
      bodyParts.push(
        obj(
          pageObjNum,
          `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`,
        ),
      );
      bodyParts.push(streamObj(contentObjNum, `<< /Length ${Buffer.byteLength(content, "latin1")} >>`, content));
    } else {
      const contentObjNum = nextObjNum++;
      const xobjectObjNum = nextObjNum++;
      const content = `q 100 0 0 100 10 10 cm /Im${xobjectObjNum} Do Q`;
      // A minimal 1x1 raw RGB image XObject — no filter, so pdf.js accepts it structurally with no
      // decode step; pixel content is irrelevant since these tests only assert on extracted text
      // (there is none) and page count, never rendered image content.
      const imageData = Buffer.from([0, 0, 0]);
      bodyParts.push(
        obj(
          pageObjNum,
          `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 200 200] /Contents ${contentObjNum} 0 R /Resources << /XObject << /Im${xobjectObjNum} ${xobjectObjNum} 0 R >> >> >>`,
        ),
      );
      bodyParts.push(streamObj(contentObjNum, `<< /Length ${Buffer.byteLength(content, "latin1")} >>`, content));
      bodyParts.push(
        streamObj(
          xobjectObjNum,
          `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageData.length} >>`,
          imageData.toString("latin1"),
        ),
      );
    }
  }

  const catalog = obj(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  const pagesObj = obj(PAGES, `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const fontObj = obj(FONT, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let body = "%PDF-1.4\n" + catalog + pagesObj + fontObj + bodyParts.join("");
  body += `trailer\n<< /Size ${nextObjNum} /Root ${CATALOG} 0 R >>\n`;
  body += `startxref\n0\n%%EOF`;
  return Buffer.from(body, "latin1");
}

// Resource-exhaustion shapes: a tiny file whose single FlateDecode stream inflates to
// `decodedBytes`. "operators": every page shares one content stream of a short text line followed
// by `q Q ` (save/restore) operators — cheap to store, slow for pdf.js to interpret. "font": one
// page whose TrueType font program is that many zero bytes — pdf.js inflates it into one growing
// buffer, which V8's heap limits never count.
export function buildPdfBomb(shape: "operators" | "font", decodedBytes: number, pages = 1): Buffer {
  const text = "BT /F1 12 Tf 20 700 Td (The Licensee shall pay the monthly license fee on or before the fifth day.) Tj ET\n";
  const objects = new Map<number, Buffer>();
  const put = (num: number, dict: string, stream?: Buffer) =>
    objects.set(
      num,
      stream === undefined
        ? Buffer.from(dict, "latin1")
        : Buffer.concat([Buffer.from(`${dict}\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1")]),
    );

  const pageNums = Array.from({ length: pages }, (_, i) => 10 + i);
  put(1, "<< /Type /Catalog /Pages 2 0 R >>");
  put(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages} >>`);
  if (shape === "operators") {
    const content = deflateSync(Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(decodedBytes, "q Q ")]));
    put(3, `<< /Length ${content.length} /Filter /FlateDecode >>`, content);
    put(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  } else {
    put(3, `<< /Length ${text.length} >>`, Buffer.from(text, "latin1"));
    put(4, "<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAB+Bomb /FirstChar 32 /LastChar 126 /FontDescriptor 5 0 R >>");
    put(5, "<< /Type /FontDescriptor /FontName /AAAAAB+Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 6 0 R >>");
    const fontProgram = deflateSync(Buffer.alloc(decodedBytes));
    put(6, `<< /Length ${fontProgram.length} /Filter /FlateDecode >>`, fontProgram);
  }
  for (const num of pageNums) {
    put(num, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>");
  }

  // A real xref table: offsets are known here, and pdf.js's reconstruct-the-xref fallback would
  // otherwise scan every byte of the compressed stream first.
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  const offsets = new Map<number, number>();
  let length = parts[0].length;
  for (const [num, body] of [...objects].sort(([a], [b]) => a - b)) {
    const framed = Buffer.concat([Buffer.from(`${num} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets.set(num, length);
    parts.push(framed);
    length += framed.length;
  }
  const size = Math.max(...objects.keys()) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num++) {
    const offset = offsets.get(num);
    xref += offset === undefined ? "0000000000 65535 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
