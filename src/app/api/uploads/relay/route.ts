import { route } from "@/server/http/handler";
import { MAX_RELAY_UPLOAD_BYTES, verifyRelayToken } from "@/server/http/uploads";
import { UploadRelayOutput, UploadRelayQuery } from "@/shared/contracts/uploads";

// The local server-relay upload target (the uploadUrl POST /api/uploads returns locally). Writes
// only with a valid token this server signed; the ref comes from the token, never from the client.
export const PUT = route({
  query: UploadRelayQuery,
  body: "file",
  maxBodyBytes: MAX_RELAY_UPLOAD_BYTES,
  usesLlm: false,
  response: UploadRelayOutput,
  run: async ({ deps, principal, query, body }) => {
    const ref = verifyRelayToken(query.token);
    await deps.storage.writeRelayed(principal, ref, body);
    return { ref };
  },
});
