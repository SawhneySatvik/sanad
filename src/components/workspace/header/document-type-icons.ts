/** Document-type glyphs. An undetected/unrecognised type falls back to FileText — the same treatment `generic` gets. */

import { House, Briefcase, Lock, Shield, Handshake, FileText, type LucideIcon } from "lucide-react";

const DOCUMENT_TYPE_ICONS: Record<string, LucideIcon> = {
  leave_and_license: House,
  job_offer_letter: Briefcase,
  nda: Lock,
  privacy_policy: Shield,
  freelance_service_agreement: Handshake,
  generic: FileText,
};

export function documentTypeIcon(documentType: string | null): LucideIcon {
  if (!documentType) return FileText;
  return DOCUMENT_TYPE_ICONS[documentType] ?? FileText;
}
