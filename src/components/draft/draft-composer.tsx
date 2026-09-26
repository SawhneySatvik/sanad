"use client";

/**
 * The from-scratch/grounded creation form. Mode<->type pairing is deliberate: the type Select only
 * ever offers the five from-scratch types, or the fixed "Grounded Response Draft" label in grounded
 * mode — never both in the same render.
 *
 * Fully controlled: the parent (DraftNewClient) owns every field's state, because it also needs
 * `mode` itself to decide whether the documents list is worth fetching at all (no need to pay for
 * that request on a from-scratch draft) and to react to the async `?grounding=` deep-link resolve
 * before this component ever mounts with a seeded value.
 */

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/feedback/empty-state";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { FileText } from "lucide-react";
import { DRAFTABLE_TYPES, GROUNDED_RESPONSE_LABEL, type FromScratchDocumentTypeId } from "@/lib/copy/document-type-labels";
import { GroundingDocumentPicker, type GroundingOption } from "./grounding-document-picker";
import { InstructionsField } from "./instructions-field";
import {
  DOCUMENT_GROUNDED_DESCRIPTION,
  DOCUMENT_GROUNDED_LABEL,
  DRAFT_ACTION_LABEL,
  FROM_SCRATCH_DESCRIPTION,
  FROM_SCRATCH_LABEL,
  FROM_SCRATCH_PLACEHOLDER_BY_TYPE,
  GROUNDED_PLACEHOLDER,
  INSTRUCTIONS_MAX_LENGTH,
  NO_DOCUMENTS_NOTE,
} from "./copy";

export type DraftMode = "unset" | "from_scratch" | "document_grounded";

export interface DraftComposerProps {
  mode: DraftMode;
  onModeChange: (mode: "from_scratch" | "document_grounded") => void;
  documentType: FromScratchDocumentTypeId | null;
  onDocumentTypeChange: (documentType: FromScratchDocumentTypeId) => void;
  groundingDocumentId: string | null;
  onGroundingDocumentIdChange: (documentId: string) => void;
  groundingOptions: GroundingOption[];
  groundingOptionsLoading: boolean;
  userInstructions: string;
  onUserInstructionsChange: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  offline: boolean;
}

export function canSubmitDraft(props: Pick<DraftComposerProps, "mode" | "documentType" | "groundingDocumentId" | "groundingOptions" | "userInstructions" | "offline" | "submitting">): boolean {
  const trimmed = props.userInstructions.trim();
  const instructionsValid = trimmed.length > 0 && props.userInstructions.length <= INSTRUCTIONS_MAX_LENGTH;
  const modeValid =
    props.mode === "from_scratch" ? props.documentType !== null : props.mode === "document_grounded" ? props.groundingDocumentId !== null : false;
  const selectedOption = props.groundingOptions.find((option) => option.id === props.groundingDocumentId) ?? null;
  const groundingReady = props.mode !== "document_grounded" || selectedOption?.processingStatus === "ready";
  return instructionsValid && modeValid && groundingReady && !props.offline && !props.submitting;
}

export function DraftComposer(props: DraftComposerProps) {
  const {
    mode,
    onModeChange,
    documentType,
    onDocumentTypeChange,
    groundingDocumentId,
    onGroundingDocumentIdChange,
    groundingOptions,
    groundingOptionsLoading,
    userInstructions,
    onUserInstructionsChange,
    onSubmit,
    submitting,
  } = props;

  const canSubmit = canSubmitDraft(props);
  const placeholder = mode === "document_grounded" ? GROUNDED_PLACEHOLDER : documentType ? FROM_SCRATCH_PLACEHOLDER_BY_TYPE[documentType] : undefined;
  const zeroDocuments = mode === "document_grounded" && !groundingOptionsLoading && groundingOptions.length === 0;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <fieldset className="flex flex-col gap-6" disabled={submitting}>
        <legend className="sr-only">New draft</legend>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium">Mode</Label>
          <RadioGroup
            // A stable "" rather than undefined for the unset state: switching value between
            // undefined and a string mid-lifetime is what trips React's own
            // controlled/uncontrolled-component warning, even though no item ever matches "".
            value={mode === "unset" ? "" : mode}
            onValueChange={(value) => onModeChange(value as "from_scratch" | "document_grounded")}
            className="grid gap-2 sm:grid-cols-2"
          >
            {/* aria-label pins each radio's accessible name to its own title alone — the card's
                description sits in the same <label> (so the whole card is one click target), which
                would otherwise fold into the computed name too. */}
            <Label className="flex flex-col gap-1 rounded-lg border border-input p-3 font-normal has-[[data-state=checked]]:border-primary">
              <span className="flex items-center gap-2">
                <RadioGroupItem value="from_scratch" aria-label={FROM_SCRATCH_LABEL} />
                <span className="font-medium text-foreground">{FROM_SCRATCH_LABEL}</span>
              </span>
              <span className="pl-6 text-sm text-muted-foreground">{FROM_SCRATCH_DESCRIPTION}</span>
            </Label>
            <Label className="flex flex-col gap-1 rounded-lg border border-input p-3 font-normal has-[[data-state=checked]]:border-primary">
              <span className="flex items-center gap-2">
                <RadioGroupItem value="document_grounded" aria-label={DOCUMENT_GROUNDED_LABEL} />
                <span className="font-medium text-foreground">{DOCUMENT_GROUNDED_LABEL}</span>
              </span>
              <span className="pl-6 text-sm text-muted-foreground">{DOCUMENT_GROUNDED_DESCRIPTION}</span>
            </Label>
          </RadioGroup>
        </div>

        {mode === "from_scratch" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="draft-document-type">Document type</Label>
            <Select value={documentType ?? ""} onValueChange={(value) => onDocumentTypeChange(value as FromScratchDocumentTypeId)}>
              <SelectTrigger id="draft-document-type" className="w-full">
                <SelectValue placeholder="Choose a document type" />
              </SelectTrigger>
              <SelectContent>
                {DRAFTABLE_TYPES.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {mode === "document_grounded" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="draft-document-type-grounded">Document type</Label>
              <Select value="grounded_response" disabled>
                <SelectTrigger id="draft-document-type-grounded" className="w-full">
                  <SelectValue>{GROUNDED_RESPONSE_LABEL}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="grounded_response">{GROUNDED_RESPONSE_LABEL}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {zeroDocuments ? (
              <EmptyState heading="Nothing to ground on yet" body={NO_DOCUMENTS_NOTE} icon={FileText} headingLevel={3} />
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="draft-grounding-document">Document to respond to</Label>
                <GroundingDocumentPicker
                  id="draft-grounding-document"
                  options={groundingOptions}
                  value={groundingDocumentId}
                  onChange={onGroundingDocumentIdChange}
                  loading={groundingOptionsLoading}
                />
              </div>
            )}
          </div>
        )}

        {mode !== "unset" && (
          <InstructionsField label="What do you want this draft to say?" value={userInstructions} onChange={onUserInstructionsChange} placeholder={placeholder} />
        )}

        <Button type="submit" aria-disabled={!canSubmit} disabled={!canSubmit} className="sm:w-fit">
          {submitting ? "Drafting…" : DRAFT_ACTION_LABEL}
        </Button>

        <DisclaimerLine variant="composer" />
      </fieldset>
    </form>
  );
}
