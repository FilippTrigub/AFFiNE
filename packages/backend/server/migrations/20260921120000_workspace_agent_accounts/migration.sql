-- A workspace agent account: a non-human identity that exists to serve exactly
-- one workspace over MCP. NULL for every ordinary user.
ALTER TABLE "users" ADD COLUMN "agent_of_workspace_id" VARCHAR;

ALTER TABLE "users"
  ADD CONSTRAINT "users_agent_of_workspace_id_fkey"
  FOREIGN KEY ("agent_of_workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "users_agent_of_workspace_id_idx" ON "users"("agent_of_workspace_id");
