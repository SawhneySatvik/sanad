import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { SaveToProjectInput, SaveToProjectOutput } from "@/shared/contracts/projects";

// A standalone document can be saved into a project after the fact. One service call —
// projects.saveToProject checks canAccess on both the document and the project inside one
// transaction. Never reads deps.llm.
export const POST = route({
  params: IdParams,
  body: SaveToProjectInput,
  usesLlm: false,
  response: SaveToProjectOutput,
  run: async ({ deps, principal, params, body }) =>
    projects.saveToProject(deps.db, principal, { kind: "document", id: params.id }, body.projectId),
});
