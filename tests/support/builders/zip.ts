import { deflateRawSync } from "node:zlib";

// Test-only helper — builds minimal, valid ZIP (and therefore DOCX, since a DOCX is just a ZIP
// with OOXML parts inside) buffers in memory, so adversarial fixtures never need to be committed
// as binary fixtures. Mirrors exactly the subset of the ZIP format docx-guard.ts's reader understands.

export interface ZipEntryInput {
  filename: string;
  content: Buffer;
  method?: "store" | "deflate";
}

export function buildZip(entries: ZipEntryInput[], options: { claimedEntryCount?: number } = {}): Buffer {
  const { locals, centralDir } = buildZipParts(entries, 0);
  const eocd = buildEndOfCentralDirectory({
    entryCount: options.claimedEntryCount ?? entries.length,
    centralDirSize: centralDir.length,
    centralDirOffset: locals.length,
  });
  return Buffer.concat([locals, centralDir, eocd]);
}

// The jszip `reader.zero` differential: when the EOCD's central directory ends before the EOCD
// itself, jszip assumes bytes were prepended and shifts every offset by the gap — so it reads
// `hidden`'s central directory and local files, while a reader that trusts the EOCD offset reads
// `visible`'s. `visible`'s local files must be at least as long as `hidden`'s.
export function buildRebasingZip(visible: ZipEntryInput[], hidden: ZipEntryInput[]): Buffer {
  const visibleParts = buildZipParts(visible, 0);
  const hiddenLocalsLength = buildZipParts(hidden, 0).locals.length;
  const rebaseBy = visibleParts.centralDir.length + hiddenLocalsLength;
  const hiddenBaseOffset = visibleParts.locals.length + visibleParts.centralDir.length - rebaseBy;
  if (hiddenBaseOffset < 0) throw new Error("visible entries must be at least as long as hidden ones");
  const hiddenParts = buildZipParts(hidden, hiddenBaseOffset);
  const eocd = buildEndOfCentralDirectory({
    entryCount: visible.length,
    centralDirSize: hiddenParts.centralDir.length,
    centralDirOffset: visibleParts.locals.length,
  });
  return Buffer.concat([visibleParts.locals, visibleParts.centralDir, hiddenParts.locals, hiddenParts.centralDir, eocd]);
}

function buildEndOfCentralDirectory(fields: { entryCount: number; centralDirSize: number; centralDirOffset: number }): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(fields.entryCount, 8); // entries on this disk
  eocd.writeUInt16LE(fields.entryCount, 10); // total entries
  eocd.writeUInt32LE(fields.centralDirSize, 12);
  eocd.writeUInt32LE(fields.centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

// Local file records and central-directory records for `entries`, with local-header offsets
// counted from `baseOffset`.
function buildZipParts(entries: ZipEntryInput[], baseOffset: number): { locals: Buffer; centralDir: Buffer } {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? "deflate";
    const methodCode = method === "store" ? 0 : 8;
    const data = method === "store" ? entry.content : deflateRawSync(entry.content);
    const nameBuf = Buffer.from(entry.filename, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(methodCode, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc-32 (unchecked by our reader/mammoth's test-relevant paths)
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.content.length, 22); // uncompressed size (declared — deliberately NOT trusted by docx-guard.ts)
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    const localHeaderOffset = offset;
    localParts.push(localHeader, nameBuf, data);
    offset += localHeader.length + nameBuf.length + data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(methodCode, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc-32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(entry.content.length, 24); // uncompressed size (declared)
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(baseOffset + localHeaderOffset, 42);

    centralParts.push(centralHeader, nameBuf);
  }

  return { locals: Buffer.concat(localParts), centralDir: Buffer.concat(centralParts) };
}

// Builds a minimal, mammoth-parseable DOCX whose single document.xml part contains a highly-
// compressible, deliberately huge amount of repetitive content — a small compressed file, a large
// declared/true decompressed size (the actual "XML bomb" shape).
export function buildDocxBomb(decompressedXmlByteLength: number): Buffer {
  const paragraphs = "<w:p><w:r><w:t>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</w:t></w:r></w:p>";
  const repeatCount = Math.ceil(decompressedXmlByteLength / paragraphs.length);
  const body = paragraphs.repeat(repeatCount);
  return buildZip(docxEntries(documentXmlWithBody(body)));
}

// A document.xml holding one paragraph per string.
export function docxDocumentXml(paragraphs: string[]): Buffer {
  return documentXmlWithBody(paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join(""));
}

// The three parts mammoth needs to read a DOCX, with `documentXml` as the main document part.
export function docxEntries(documentXml: Buffer): ZipEntryInput[] {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return [
    { filename: "[Content_Types].xml", content: Buffer.from(contentTypes, "utf8"), method: "deflate" },
    { filename: "_rels/.rels", content: Buffer.from(rels, "utf8"), method: "deflate" },
    { filename: "word/document.xml", content: documentXml, method: "deflate" },
  ];
}

function documentXmlWithBody(body: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    "utf8",
  );
}
