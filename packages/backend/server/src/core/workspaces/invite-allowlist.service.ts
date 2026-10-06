import { Injectable, Logger } from '@nestjs/common';

import { Config } from '../../base';
import { addInviteeToAllowlist } from '../auth/email-allowlist';
import { ServerService } from '../config';

/**
 * Records an invited address in `auth.allowedEmailDomains`, pointing at the
 * workspace it was invited to, so the admin panel shows who was let in and where.
 *
 * Best-effort: a failed write is logged and swallowed, because the invite has
 * already been reserved and must not be reported as failed over bookkeeping.
 */
@Injectable()
export class InviteAllowlistService {
  private readonly logger = new Logger(InviteAllowlistService.name);
  // `updateConfig` replaces the whole array, so two overlapping read-merge-write
  // cycles in this process would drop one invitee. Chain them instead.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly server: ServerService
  ) {}

  record(actorId: string, email: string, workspaceId: string): Promise<void> {
    const run = this.queue.then(() => this.write(actorId, email, workspaceId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(actorId: string, email: string, workspaceId: string) {
    try {
      const next = addInviteeToAllowlist(
        this.config.auth.allowedEmailDomains,
        email,
        workspaceId
      );
      if (!next) {
        return;
      }
      await this.server.updateConfig(actorId, [
        { module: 'auth', key: 'allowedEmailDomains', value: next },
      ]);
      this.logger.log(
        `Recorded invitee [${email}] for workspace [${workspaceId}] in auth.allowedEmailDomains`
      );
    } catch (error) {
      this.logger.error(
        `Failed to record invitee [${email}] for workspace [${workspaceId}] in the signup allowlist`,
        error
      );
    }
  }
}
