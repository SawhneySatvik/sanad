import { ScanText } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export interface ScannedNoticeProps {
  inputMode: "native_document";
}

// One component, one text, on every surface — the workspace, Compare panes, Prepare and chat
// citations all render this exact copy, never a per-surface rewording that could drift.
const COPY =
  "This document was read from a scanned image. Saboot's transcription may contain errors, so its quotes are approximate at best — never verified.";

/**
 * Persistent, never-dismissible banner for a native_document (scanned) source. role="note", not
 * role="alert" — it never announces (it isn't one of the app's live regions); this is distinct from
 * DocumentViewer's own persistent pane label ("Transcribed from an image — not independent
 * evidence."), which belongs to the document pane only and is never called ScannedNotice.
 */
export function ScannedNotice({ inputMode }: ScannedNoticeProps) {
  void inputMode; // the prop exists so a caller only renders this when inputMode === "native_document" is already true
  return (
    <Alert role="note">
      <ScanText aria-hidden="true" className="size-5" strokeWidth={1.75} />
      <AlertDescription>{COPY}</AlertDescription>
    </Alert>
  );
}
