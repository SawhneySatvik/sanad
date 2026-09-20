import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { SaveToProjectInput, SaveToProjectOutput } from "@/shared/contracts/projects";

// A standalone thread can be saved into a project after the fact — mirrors the documents
// save-to-project route. Threads have no guest owner, so a guest gets the same NOT_FOUND a foreign
// owner does. One service call; never reads deps.llm.
export const POST = route({
  params: IdParams,
  body: SaveToProjectInput,
  usesLlm: false,
  response: SaveToProjectOutput,
  run: async ({ deps, principal, params, body }) =>
    projects.saveToProject(deps.db, principal, { kind: "thread", id: params.id }, body.projectId),
});
