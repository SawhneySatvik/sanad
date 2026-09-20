import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { SaveToProjectInput, SaveToProjectOutput } from "@/shared/contracts/projects";

// A standalone comparison can be saved into a project after the fact — mirrors the documents
// save-to-project route. One service call; never reads deps.llm.
export const POST = route({
  params: IdParams,
  body: SaveToProjectInput,
  usesLlm: false,
  response: SaveToProjectOutput,
  run: async ({ deps, principal, params, body }) =>
    projects.saveToProject(deps.db, principal, { kind: "comparison", id: params.id }, body.projectId),
});
