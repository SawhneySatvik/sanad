"use client";

/** Clickable prompts that FILL, never auto-send, the composer. Real <button>s. */

import { Button } from "@/components/ui/button";

export interface StarterPromptsProps {
  prompts: readonly string[];
  onSelect: (prompt: string) => void;
}

export function StarterPrompts({ prompts, onSelect }: StarterPromptsProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {prompts.map((prompt) => (
        <Button
          key={prompt}
          type="button"
          variant="outline"
          className="h-auto justify-start px-3 py-2 text-left whitespace-normal"
          onClick={() => onSelect(prompt)}
        >
          {prompt}
        </Button>
      ))}
    </div>
  );
}
