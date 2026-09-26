"use client";

/**
 * Download / print / copy-as-text. `copyText` defaults to `exportText` when omitted — Draft passes
 * the same plain-text content for both (nothing to diverge); Prepare (a separate surface) passes its
 * own structured plain-text rendering as `copyText` while `exportText`/`exportFilename` still drive
 * the Markdown download. `onPrint` is optional and only ever adds the "Print" item when a caller
 * actually supplies it — Draft omits it entirely (it has no print concept of its own), so this menu
 * shows only "Download" and "Copy" there.
 *
 * Download is a client-side Blob of `exportText`, named `exportFilename` verbatim — no in-app
 * rendering step exists for either format; this app never installs a Markdown renderer.
 */

import { Copy, Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { writeToClipboard } from "./clipboard";

export interface ExportMenuProps {
  exportText: string;
  exportFilename: string;
  copyText?: string;
  onPrint?: () => void;
}

// The download's own MIME type, derived from exportFilename's extension — never hard-coded to one
// format, since Prepare's own call site downloads .md while Draft downloads .txt through this same
// component.
function mimeTypeFor(filename: string): string {
  if (filename.endsWith(".md")) return "text/markdown;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function downloadBlob(text: string, filename: string): void {
  const blob = new Blob([text], { type: mimeTypeFor(filename) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeToClipboard(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy to the clipboard.");
  }
}

export function ExportMenu({ exportText, exportFilename, copyText, onPrint }: ExportMenuProps) {
  const textToCopy = copyText ?? exportText;

  return (
    // Non-modal, as ItemMenu: a modal Radix menu aria-hides the page behind it without taking its
    // controls out of the Tab order.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Download aria-hidden="true" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => downloadBlob(exportText, exportFilename)}>
          <Download aria-hidden="true" />
          Download
        </DropdownMenuItem>
        {onPrint && (
          <DropdownMenuItem onSelect={onPrint}>
            <Printer aria-hidden="true" />
            Print
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void copyToClipboard(textToCopy)}>
          <Copy aria-hidden="true" />
          Copy
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
