/**
 * This directory's public surface — the only paths the /chat composer that mounts these components
 * imports. useUploadFlow's returned state/actions drive which of UploadProgress/UploadErrorCard (or
 * the shared feedback ErrorState, for a bare INTERNAL_ERROR) the caller renders in its own "card
 * above the composer" slot.
 */

export { UploadDropzone, FILE_INPUT_ACCEPT, type UploadDropzoneProps } from "./upload-dropzone";
export { UploadProgress, type UploadProgressProps } from "./upload-progress";
export { UploadErrorCard, type UploadErrorCardProps, type UploadCardError, type UploadCardErrorCode } from "./upload-error-card";
export { UploadRetentionNotice, type UploadRetentionNoticeProps } from "./upload-retention-notice";
export { SignInNudge, type SignInNudgeProps } from "./sign-in-nudge";
export { useUploadFlow, type UseUploadFlowOptions, type UseUploadFlowResult, type UploadFlowPhase, type UploadFlowFileMeta } from "./use-upload-flow";
export { runClientPreChecks, type ClientPreCheckReason, type ClientPreCheckResult } from "./client-pre-checks";
export { MAX_UPLOAD_SIZE_BYTES, ALLOWED_MIME_TYPES, ACCEPTED_TYPES_LABEL } from "./constants";
export { UploadInterruptedError, type UploadFlowErrorCode } from "./api";
