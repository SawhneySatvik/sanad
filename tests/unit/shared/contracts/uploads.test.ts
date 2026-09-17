import { describe, expect, it } from "vitest";
import { CreateUploadTargetInput, UploadRelayQuery, UploadTargetOutput } from "@/shared/contracts/uploads";

describe("upload contracts", () => {
  it("CreateUploadTargetInput is strict and needs a positive integer size", () => {
    const input = { filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 };
    expect(CreateUploadTargetInput.parse(input)).toEqual(input);
    expect(CreateUploadTargetInput.safeParse({ ...input, ref: "guest:a/b/c" }).success).toBe(false);
    expect(CreateUploadTargetInput.safeParse({ ...input, sizeBytes: 0 }).success).toBe(false);
    expect(CreateUploadTargetInput.safeParse({ ...input, sizeBytes: 1.5 }).success).toBe(false);
  });

  it("UploadTargetOutput always carries an uploadUrl — the client flow is the same locally and in prod", () => {
    expect(UploadTargetOutput.safeParse({ method: "server-relay", ref: "guest:a/b/c" }).success).toBe(false);
    expect(
      UploadTargetOutput.safeParse({ method: "direct-put", uploadUrl: "https://storage/signed", ref: "user:a/b/c" }).success,
    ).toBe(true);
  });

  it("UploadRelayQuery takes exactly one bounded token — never a bare ref", () => {
    expect(UploadRelayQuery.safeParse({ token: "local-storage:///object?ref=a&expires=1&sig=b" }).success).toBe(true);
    expect(UploadRelayQuery.safeParse({ token: "" }).success).toBe(false);
    expect(UploadRelayQuery.safeParse({ token: "x".repeat(4097) }).success).toBe(false);
    expect(UploadRelayQuery.safeParse({ ref: "guest:a/b/c" }).success).toBe(false);
    expect(UploadRelayQuery.safeParse({ token: "t", ref: "guest:a/b/c" }).success).toBe(false);
  });
});
