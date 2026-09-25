import { projectDetailView } from "@/server/http/views/project-view";
import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { ProjectDetailOutput } from "@/shared/contracts/projects";
import * as library from "@/server/services/library";
import { RenameProjectInput } from "@/shared/contracts/library";
import { ProjectOutput } from "@/shared/contracts/projects";

export const PATCH = route({
  params: IdParams, body: RenameProjectInput, usesLlm: false, response: ProjectOutput,
  run: ({ deps, principal, params, body }) => library.rename(deps, principal, "project", params.id, body.name),
});

export const DELETE = route({
  params: IdParams, usesLlm: false, status: 204,
  run: ({ deps, principal, params }) => library.remove(deps, principal, "project", params.id),
});

// getProject() never reads deps.llm (a read needs no provider key).
export const GET = route({
  params: IdParams,
  usesLlm: false,
  response: ProjectDetailOutput,
  run: async ({ deps, principal, params }) => projectDetailView(await projects.getProject(deps.db, principal, params.id)),
});
