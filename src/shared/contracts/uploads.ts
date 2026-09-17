/**
 * POST /api/uploads and PUT /api/uploads/relay. Client flow: POST /api/uploads, PUT the file bytes
 * to `uploadUrl`, POST /api/documents with the `ref`. The filename and type declared here are the
 * ones the document keeps. The mime-type allowlist and size cap are enforced by the storage
 * adapter, not duplicated here — that layer pulls in server-only code a shared contract must not
 * import.
 */

import { z } from "zod";

/** POST /api/uploads' request body. */
export const CreateUploadTargetInput = z.strictObject({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});
export type CreateUploadTargetInput = z.infer<typeof CreateUploadTargetInput>;

/** Where and how the client uploads next: a direct-put signed URL, or the local relay endpoint. */
export const UploadTargetOutput = z.object({
  method: z.enum(["direct-put", "server-relay"]),
  uploadUrl: z.string().min(1),
  ref: z.string().min(1),
});
export type UploadTargetOutput = z.infer<typeof UploadTargetOutput>;

/** PUT /api/uploads/relay's query; `token` is opaque to the client. The request body is the raw file bytes. */
export const UploadRelayQuery = z.strictObject({ token: z.string().min(1).max(4096) });
export type UploadRelayQuery = z.infer<typeof UploadRelayQuery>;

/** PUT /api/uploads/relay's response. */
export const UploadRelayOutput = z.object({ ref: z.string().min(1) });
export type UploadRelayOutput = z.infer<typeof UploadRelayOutput>;
