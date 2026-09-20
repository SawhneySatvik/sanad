import { projectDetailView } from "@/server/http/views/project-view";
import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { IdParams } from "@/shared/contracts/common";
import { ProjectDetailOutput } from "@/shared/contracts/projects";

// getProject() never reads deps.llm (a read needs no provider key).
export const GET = route({
  params: IdParams,
  usesLlm: false,
  response: ProjectDetailOutput,
  run: async ({ deps, principal, params }) => projectDetailView(await projects.getProject(deps.db, principal, params.id)),
});
