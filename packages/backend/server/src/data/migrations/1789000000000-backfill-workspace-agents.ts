import { PrismaClient } from '@prisma/client';

/**
 * Every workspace owns one agent account. New workspaces get theirs inline in
 * `WorkspaceModel.create`; this gives one to every workspace that predates that
 * change.
 *
 * Both statements are `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, so the
 * migration is idempotent and a partial failure can simply be re-run.
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

      // Collaborator ('member'), never owner or admin: those inherit doc Owner
      // unconditionally and could not be excluded from any document.
      await tx.$executeRaw`
        INSERT INTO workspace_members (workspace_id, user_id, role, state, source, created_at, updated_at)
        SELECT u.agent_of_workspace_id,
               u.id,
               'member',
               'active',
               'email',
               clock_timestamp(),
               clock_timestamp()
        FROM users u
        WHERE u.agent_of_workspace_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM workspace_members m
            WHERE m.workspace_id = u.agent_of_workspace_id AND m.user_id = u.id
          )
      `;
    });
  }

  static async down(_db: PrismaClient) {}
}
