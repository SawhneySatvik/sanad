/**
 * StarterPrompts' four fixed sets, keyed by the remembered saboot:situation:v1 chip role — Saboot
 * explains documents rather than giving legal advice, so every prompt asks for information, never
 * an opinion (none asks "is X allowed, enforceable or fair").
 */

import type { SituationRole } from "./catalogue";

const DEFAULT_PROMPTS = [
  "What should I look for before signing a rental agreement?",
  "What does an offer letter's non-compete clause typically restrict?",
  "What's a normal notice period for a freelance contract?",
  "Explain what an NDA actually obligates me to do.",
] as const;

const TENANT_PROMPTS = [
  "What happens if I want to leave before my lock-in period ends?",
  "What does this lease say happens to my deposit?",
  "What counts as a valid notice to vacate?",
  "What does this lease say about rent increases during the agreement?",
] as const;

const EMPLOYEE_PROMPTS = [
  "What does my offer letter say about a non-compete?",
  "What does a 'service bond' really commit me to?",
  "How much notice do I owe if I resign early?",
  "What should I ask HR about my probation period?",
] as const;

const FREELANCER_PROMPTS = [
  "Who owns the IP I create before the client has paid me?",
  "What does this contract say about a kill fee if the project is cancelled midway?",
  "What does this contract say about late payment by the client?",
  "What does 'exclusive services' actually restrict me from doing?",
] as const;

export function starterPromptsFor(role: SituationRole | null): readonly string[] {
  switch (role) {
    case "tenant":
      return TENANT_PROMPTS;
    case "employee":
      return EMPLOYEE_PROMPTS;
    case "freelancer":
      return FREELANCER_PROMPTS;
    default:
      return DEFAULT_PROMPTS;
  }
}
