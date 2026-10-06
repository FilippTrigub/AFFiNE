-- Machine translations of published docs, one row per target language.
CREATE TABLE "doc_translations" (
    "workspace_id" VARCHAR NOT NULL,
    "doc_id" VARCHAR NOT NULL,
    "lang" VARCHAR(8) NOT NULL,
    "source_lang" VARCHAR(8) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "title" VARCHAR,
    "bin" BYTEA,
    "error" VARCHAR,
    "source_timestamp" TIMESTAMPTZ(3),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doc_translations_pkey" PRIMARY KEY ("workspace_id","doc_id","lang")
);

CREATE INDEX "doc_translations_status_available_at_idx" ON "doc_translations"("status", "available_at");

ALTER TABLE "doc_translations" ADD CONSTRAINT "doc_translations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
