import { Injectable, Logger } from '@nestjs/common';

import { Config, OnEvent } from '../../base';
import { Models, WorkspaceMemberStatus, WorkspaceRole } from '../../models';
import { resolveWorkspaceGrants } from './email-allowlist';

declare global {
  interface Events {
    /**
     * A sign-in that created the account it signed in to. Emitted for the paths
     * that create users inside the Rust runtime — OAuth and magic link — which
     * never reach `models/user.ts` and so never emit `user.created`.
     */
    'user.signedUp': { id: string; email: string };
  }
}

/**
 * Adds a newly created account to the workspaces its allowlist entry grants.
 *
 * Grants apply at account creation only. Editing the allowlist later neither
 * adds existing users to a workspace nor removes anyone from one, so an admin
 * who takes a member out of a workspace in the UI keeps them out.
 */
@Injectable()
export class SignupGrantsService {
  private readonly logger = new Logger(SignupGrantsService.name);

  constructor(
    private readonly config: Config,
    private readonly models: Models
  ) {}

  @OnEvent('user.created', { suppressError: true })
  async onUserCreated(user: Events['user.created']) {
    await this.apply(user.id, user.email);
  }

  @OnEvent('user.signedUp', { suppressError: true })
  async onUserSignedUp(user: Events['user.signedUp']) {
    await this.apply(user.id, user.email);
  }

  /**
   * Idempotent: `workspaceUser.set` returns the existing role untouched when it
   * already matches, so a user reaching this twice is not downgraded or
   * duplicated. Never throws — a failed grant must not fail the sign-up that
   * triggered it, and the account is usable without it.
   */
  async apply(userId: string, email: string) {
    const grants = resolveWorkspaceGrants(
      email,
      this.config.auth.allowedEmailDomains
    );
    if (!grants.length) {
      return;
    }

    // An agent account belongs to exactly one workspace, which its creator has
    // already joined it to. The allowlist must never widen that. Checked here
    // rather than in the handlers because `user.signedUp` carries only an id
    // and an email.
    const user = await this.models.user.get(userId);
    if (user?.agentOfWorkspaceId) {
      this.logger.warn(
        `Signup grants skipped for agent account [${userId}]: an agent is bound to one workspace`
      );
      return;
    }

    for (const { workspaceId, role } of grants) {
      try {
        // A workspace id that no longer exists would otherwise surface as a
        // foreign key violation on every sign-up matching the entry.
        if (!(await this.models.workspace.get(workspaceId))) {
          this.logger.warn(
            `Signup grant skipped: workspace [${workspaceId}] in auth.allowedEmailDomains does not exist`
          );
          continue;
        }

        await this.models.workspaceUser.set(workspaceId, userId, role, {
          status: WorkspaceMemberStatus.Accepted,
        });
        this.logger.log(
          `Granted user [${userId}] role [${WorkspaceRole[role]}] in workspace [${workspaceId}] from the signup allowlist`
        );
      } catch (error) {
        this.logger.error(
          `Failed to grant user [${userId}] access to workspace [${workspaceId}]`,
          error
        );
      }
    }
  }
}
