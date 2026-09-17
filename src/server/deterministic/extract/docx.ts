import { assertDocxSafeToParse } from "./docx-guard";
import { parseInWorker } from "./sandbox";

/**
 * Extracts raw text from a DOCX file. {@link assertDocxSafeToParse} runs first, so mammoth's unzip
 * (no size bound of its own) only ever reads entries the guard measured; mammoth itself then runs
 * in a worker thread under a deadline and memory budget (see sandbox.ts).
 * @throws AppError INVALID_DOCUMENT or EXTRACTION_FAILED — see {@link assertDocxSafeToParse} and
 * {@link parseInWorker}; EXTRACTION_FAILED when mammoth can't parse the file.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  assertDocxSafeToParse(bytes);
  const { text } = await parseInWorker("docx", bytes);
  return text;
}
