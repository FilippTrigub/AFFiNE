import type {
  CreateWorkspaceAgentMcpCredentialMutationVariables,
  DocRole,
  WorkspaceAgentDocGrantsQuery,
  WorkspaceAgentMcpCredentialsQuery,
  WorkspaceAgentQuery,
} from '@affine/graphql';
import { LiveData, Service } from '@toeverything/infra';

import type { WorkspaceAgentStore } from '../stores/workspace-agent';

export type WorkspaceAgent = NonNullable<WorkspaceAgentQuery['workspaceAgent']>;
export type WorkspaceAgentCredential =
  WorkspaceAgentMcpCredentialsQuery['workspaceAgentMcpCredentials'][number];
export type WorkspaceAgentDocGrant =
  WorkspaceAgentDocGrantsQuery['workspaceAgentDocGrants'][number];

export class WorkspaceAgentService extends Service {
  private revalidationId = 0;

  constructor(private readonly store: WorkspaceAgentStore) {
    super();
  }

  agent$ = new LiveData<WorkspaceAgent | null>(null);
  credentials$ = new LiveData<WorkspaceAgentCredential[] | null>(null);
  docGrants$ = new LiveData<WorkspaceAgentDocGrant[] | null>(null);
  /** Whether this viewer may manage the agent, i.e. is a workspace admin. */
  canManage$ = new LiveData(false);
  loading$ = new LiveData(false);
  error$ = new LiveData<unknown>(null);

  /**
   * Two tiers, deliberately, because the server guards them differently:
   *
   * - `workspaceAgent` needs only `Workspace.Read`, so any member may learn
   *   that the workspace has an agent and what it is called.
   * - the credentials and the document grants need
   *   `Workspace.Settings.Update`, which is workspace Admin.
   *
   * `canManage` decides whether the second tier is even requested. Fetching it
   * unconditionally would "work" -- the request fails and the panel hides
   * itself -- but only as an accident of the rejection, which is both silent
   * for the user and fragile for the next person to touch this.
   *
   * The counter guards against a slow earlier reload landing after a newer one
   * and clobbering it -- the same guard `McpCredentialService` uses.
   */
  async revalidate(workspaceId: string, canManage: boolean) {
    const revalidationId = ++this.revalidationId;
    this.loading$.value = true;
    try {
      const agent = await this.store.agent(workspaceId);
      const [credentials, docGrants] = canManage
        ? await Promise.all([
            this.store.credentials(workspaceId),
            this.store.docGrants(workspaceId),
          ])
        : [null, null];

      if (revalidationId !== this.revalidationId) return;
      this.agent$.value = agent ?? null;
      this.canManage$.value = canManage;
      this.credentials$.value = credentials;
      this.docGrants$.value = docGrants;
      this.error$.value = null;
    } catch (error) {
      if (revalidationId !== this.revalidationId) return;
      this.error$.value = error;
    } finally {
      if (revalidationId === this.revalidationId) {
        this.loading$.value = false;
      }
    }
  }

  async createCredential(
    input: CreateWorkspaceAgentMcpCredentialMutationVariables['input']
  ) {
    const revealed = await this.store.createCredential(input);
    await this.revalidate(input.workspaceId, true);
    return revealed;
  }

  async rotateCredential(
    id: string,
    workspaceId: string,
    expirationDays: number
  ) {
    const revealed = await this.store.rotateCredential(
      id,
      workspaceId,
      expirationDays
    );
    await this.revalidate(workspaceId, true);
    return revealed;
  }

  async revokeCredential(id: string, workspaceId: string) {
    await this.store.revokeCredential(id, workspaceId);
    await this.revalidate(workspaceId, true);
  }

  async grantDoc(workspaceId: string, docId: string, role: DocRole) {
    const agent = this.agent$.value;
    if (!agent) return;
    await this.store.grantDoc(workspaceId, docId, agent.id, role);
    await this.revalidate(workspaceId, true);
  }

  async revokeDoc(workspaceId: string, docId: string) {
    const agent = this.agent$.value;
    if (!agent) return;
    await this.store.revokeDoc(workspaceId, docId, agent.id);
    await this.revalidate(workspaceId, true);
  }
}
