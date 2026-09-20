import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { SaveToProjectInput, SaveToProjectOutput } from "@/shared/contracts/projects";

// A standalone draft can be saved into a project after the fact — mirrors the documents
// save-to-project route. Saves the whole revision chain (ancestors and descendants together, never
// a partial chain). One service call; never reads deps.llm.
export const POST = route({
  params: IdParams,
  body: SaveToProjectInput,
  usesLlm: false,
  response: SaveToProjectOutput,
  run: async ({ deps, principal, params, body }) =>
    projects.saveToProject(deps.db, principal, { kind: "draft", id: params.id }, body.projectId),
});
