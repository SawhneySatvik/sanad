// Public surface of the orchestrator module — services/ask.ts imports only from here.
export { runOrchestrator } from "./run-orchestrator";
export { classify, type ClassifyResult, type RankedDomain } from "./classify";
export { MAX_DOCUMENTS_TOTAL_CHARS, MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, MAX_SPECIALISTS } from "./config";
export { SPECIALIST_IDS, SPECIALIST_REGISTRY, type SpecialistEntry, type SpecialistId } from "./specialist-registry";
export type {
  OrchestratorCitation,
  OrchestratorDocumentInput,
  OrchestratorEvent,
  OrchestratorFinalEvent,
  OrchestratorHistoryMessage,
  OrchestratorInput,
  OrchestratorMode,
} from "./types";
