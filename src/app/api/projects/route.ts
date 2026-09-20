import { projectView, projectsListView } from "@/server/http/views/project-view";
import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { CreateProjectInput, ProjectOutput, ProjectsListOutput } from "@/shared/contracts/projects";

// User principal only: requireUser refuses a guest with the same VALIDATION_FAILED createProject
// throws (no project is ever a guest's), before the body is read. Neither call ever reads deps.llm.
export const POST = route({
  body: CreateProjectInput,
  requireUser: true,
  usesLlm: false,
  response: ProjectOutput,
  run: async ({ deps, principal, body }) => projectView(await projects.createProject(deps.db, principal, body)),
});

// A guest gets an empty list, not an error (listProjects's own guest handling) — no project is ever
// a guest's, so there's nothing to hide by 404ing instead.
export const GET = route({
  usesLlm: false,
  response: ProjectsListOutput,
  run: async ({ deps, principal }) => projectsListView(await projects.listProjects(deps.db, principal)),
});
