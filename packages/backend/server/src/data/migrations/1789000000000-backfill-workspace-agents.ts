import { PrismaClient } from '@prisma/client';

/**
 * Every workspace owns one agent account. New workspaces get theirs inline in
 * `WorkspaceModel.create`; this gives one to every workspace that predates that
 * change.
 *
 * The agent is deliberately not a workspace member -- membership would consume
 * a paid seat and inflate member counts -- so only the user row is created; it
 * reaches documents through explicit `doc_grants`.
 *
 * `INSERT ... SELECT` guarded by `NOT EXISTS`, so the migration is idempotent
 * and a partial failure can simply be re-run.
 */
export class BackfillWorkspaceAgents1789000000000 {
  static async up(db: PrismaClient) {
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'backfill-workspace-agents'}, 0))`;

      // `.local` is reserved (RFC 6762): the address is a label, never a mailbox.
      await tx.$executeRaw`
        INSERT INTO users (id, name, email, registered, disabled, agent_of_workspace_id, created_at)
        SELECT gen_random_uuid(),
               'Workspace agent',
               'agent.' || w.id || '@agents.local',
               true,
               false,
               w.id,
               clock_timestamp()
        FROM workspaces w
        WHERE NOT EXISTS (
          SELECT 1 FROM users u WHERE u.agent_of_workspace_id = w.id
        )
        ON CONFLICT (email) DO NOTHING
      `;
    });
  }

  static async down(_db: PrismaClient) {}
}
