-- PENDING — not applied by db:migrate or createTestDb (the runner reads only migrations/*.sql).
--
-- Blocked on a dependency: PGlite 0.5.8 does not bundle pgvector; it ships as the separate package
-- @electric-sql/pglite-pgvector (0.0.9, peer-pinned to @electric-sql/pglite 0.5.8). To activate:
--   1. install @electric-sql/pglite-pgvector@0.0.9 and add it to next.config's
--      serverExternalPackages next to @electric-sql/pglite;
--   2. pass `extensions: { vector }` to every PGlite constructor (the DB client and the test
--      harness), add the table to src/db/schema.ts (dimensionless vector custom type), add it to the
--      table list in prod-only/0001, and move this file up into migrations/ unchanged (renumbered
--      only if 0005 has been taken by then).
--
-- The vector column is deliberately dimensionless and there is NO HNSW index: no embedding model has
-- been chosen. The HNSW (cosine) index belongs in its own later migration, over a fixed-dimension
-- expression or column, once a model is. embedding_model/embedding_dimension are stored per row so a
-- change of embedding model can never leave vectors whose producing model is unknown.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL CONSTRAINT document_embeddings_document_id_fkey REFERENCES documents (id) ON DELETE CASCADE,
  -- Denormalized from documents so retrieval filters by project before/during vector search, not after
  -- a global top-k, which would give a small project's documents poor recall.
  project_id uuid CONSTRAINT document_embeddings_project_id_fkey REFERENCES projects (id) ON DELETE SET NULL,
  chunk_text text NOT NULL,
  embedding vector NOT NULL,
  embedding_model text NOT NULL,
  embedding_dimension integer NOT NULL,
  CONSTRAINT document_embeddings_dimension_matches_check CHECK (vector_dims(embedding) = embedding_dimension)
);

CREATE INDEX document_embeddings_document_id_idx ON document_embeddings (document_id);
CREATE INDEX document_embeddings_project_id_idx ON document_embeddings (project_id);
