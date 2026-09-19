/**
 * The classifier's "no confident match / no legal angle at all" redirect: fixed text, no LLM
 * call — classify.ts's `non_legal` result is handled entirely deterministically by
 * run-orchestrator.ts, never as a silent fallback into general legal chat.
 */
export const NON_LEGAL_REDIRECT_MESSAGE =
  "I'm a legal assistant focused on legal questions and documents — for example tenancy, " +
  "employment, contracts and NDAs, privacy, or freelance work. I couldn't find a legal angle " +
  "in your message, so I haven't answered it. Could you rephrase your question so it relates " +
  "to a legal topic or an attached document?";
