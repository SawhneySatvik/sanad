import { inflateRawSync } from "node:zlib";
import { AppError } from "@/server/core/errors";
import { MAX_DOCX_DECOMPRESSED_BYTES } from "./constants";

export { MAX_DOCX_DECOMPRESSED_BYTES } from "./constants";

/**
 * Checks a DOCX (zip) file before mammoth — whose jszip dependency has no built-in size bound — ever
 * touches the bytes. Measures its true decompressed size, independently of whatever the zip's own
 * central directory claims (a crafted entry can lie): `zlib.inflateRawSync`'s `maxOutputLength`
 * throws before allocating past the remaining budget. The measurement only holds if jszip reads
 * exactly the entries measured here, so any layout jszip would read differently is rejected (see
 * readCentralDirectory). A minimal ZIP reader, not a general unzip — ZIP64 (>4GB archives) and
 * multi-disk archives are unsupported and treated as unparseable, a safe default no real DOCX here
 * would ever hit.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_ENTRY_COUNT_SENTINEL = 0xffff;
const MAIN_DOCUMENT_PART = "word/document.xml";

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function unparseable(): never {
  throw new AppError("EXTRACTION_FAILED", "The DOCX file could not be parsed.", { reason: "unreadable" });
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record sits at the end of the file, optionally followed by a comment of up to 65535
  // bytes — scan backward from the end within that bound rather than the whole file.
  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - 0xffff);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return unparseable();
}

// jszip departs from an EOCD-driven walk in three ways, each letting it read entries this guard never
// measured — so each layout is rejected:
// - it reads consecutive central-directory records until the signature stops matching, whatever
//   the EOCD's entry count says: the counted records must end exactly where the EOCD begins;
// - if the central directory ends before the EOCD, it assumes bytes were prepended and shifts every
//   offset by the gap (`reader.zero`): the directory's claimed end must be the EOCD's offset;
// - a nonzero disk number or a 0xFFFF/0xFFFFFFFF field sends it to ZIP64 records this reader never
//   parses: only a single-disk, non-ZIP64 EOCD is read (the offset+size check rules out 0xFFFFFFFF
//   in a file under 4 GB).
function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDirDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === ZIP64_ENTRY_COUNT_SENTINEL ||
    centralDirOffset + centralDirSize !== eocdOffset ||
    // Nothing may follow the EOCD record's own comment.
    eocdOffset + EOCD_MIN_SIZE + commentLength !== buffer.length
  ) {
    unparseable();
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      unparseable();
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      unparseable(); // ZIP64 — unsupported
    }

    entries.push({ compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  if (offset !== eocdOffset) unparseable();
  return entries;
}

// The entry's name and data, read from its local header — the name jszip, and so mammoth, uses.
function readLocalFile(buffer: Buffer, entry: ZipEntry): { fileName: string; data: Buffer } {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    unparseable();
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraFieldLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) unparseable();
  return {
    fileName: buffer.toString("latin1", offset + 30, offset + 30 + fileNameLength),
    data: buffer.subarray(dataStart, dataEnd),
  };
}

/**
 * Rejects a DOCX that mammoth must not parse: a zip jszip would read differently from this guard,
 * one with no word/document.xml, or one whose true decompressed size exceeds
 * {@link MAX_DOCX_DECOMPRESSED_BYTES}. Never calls mammoth — this only reads and measures, so it's
 * safe to run before mammoth touches the bytes at all.
 * @throws AppError INVALID_DOCUMENT when the decompressed-size cap is exceeded or the zip isn't a DOCX.
 * @throws AppError EXTRACTION_FAILED when the input isn't a well-formed zip.
 */
export function assertDocxSafeToParse(bytes: Uint8Array): void {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const entries = readCentralDirectory(buffer);
  let remainingBudget = MAX_DOCX_DECOMPRESSED_BYTES;
  let hasMainDocumentPart = false;

  for (const entry of entries) {
    const { fileName, data } = readLocalFile(buffer, entry);
    if (fileName === MAIN_DOCUMENT_PART) hasMainDocumentPart = true;

    if (entry.compressionMethod === 0) {
      // Stored (no compression) — the compressed size IS the real size, no inflate needed.
      remainingBudget -= data.length;
    } else if (entry.compressionMethod === 8) {
      try {
        // Never trust the declared uncompressed size in the header — bounded so this can never
        // allocate past the remaining budget.
        const inflated = inflateRawSync(data, {
          maxOutputLength: Math.max(0, remainingBudget),
        });
        remainingBudget -= inflated.length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new AppError(
            "INVALID_DOCUMENT",
            `Document exceeds the ${MAX_DOCX_DECOMPRESSED_BYTES}-byte decompressed-size cap.`,
            { reason: "too_large" },
          );
        }
        unparseable();
      }
    } else {
      // Any other declared compression method isn't valid in a standard OOXML package — reject
      // rather than silently skip it, which could hide a bomb using an unexpected method.
      unparseable();
    }

    if (remainingBudget < 0) {
      throw new AppError(
        "INVALID_DOCUMENT",
        `Document exceeds the ${MAX_DOCX_DECOMPRESSED_BYTES}-byte decompressed-size cap.`,
        { reason: "too_large" },
      );
    }
  }

  if (!hasMainDocumentPart) {
    // INVALID_DOCUMENT, not EXTRACTION_FAILED: a well-formed zip missing the main part is still a
    // parseable archive, just not a DOCX — but it's just as unreadable as a file unparseable()
    // rejects, so it shares that same reason.
    throw new AppError(
      "INVALID_DOCUMENT",
      `The file is not a DOCX document: it has no ${MAIN_DOCUMENT_PART}.`,
      { reason: "unreadable" },
    );
  }
}
