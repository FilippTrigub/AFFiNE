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
  loading$ = new LiveData(false);
  error$ = new LiveData<unknown>(null);

  /**
   * The counter guards against a slow earlier reload landing after a newer one
   * and clobbering it -- the same guard `McpCredentialService` uses.
   */
  async revalidate(workspaceId: string) {
    const revalidationId = ++this.revalidationId;
    this.loading$.value = true;
    try {
      const [agent, credentials, docGrants] = await Promise.all([
        this.store.agent(workspaceId),
        this.store.credentials(workspaceId),
        this.store.docGrants(workspaceId),
      ]);
      if (revalidationId !== this.revalidationId) return;
      this.agent$.value = agent ?? null;
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
    await this.revalidate(input.workspaceId);
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
    await this.revalidate(workspaceId);
    return revealed;
  }

  async revokeCredential(id: string, workspaceId: string) {
    await this.store.revokeCredential(id, workspaceId);
    await this.revalidate(workspaceId);
  }

  async grantDoc(workspaceId: string, docId: string, role: DocRole) {
    const agent = this.agent$.value;
    if (!agent) return;
    await this.store.grantDoc(workspaceId, docId, agent.id, role);
    await this.revalidate(workspaceId);
  }

  async revokeDoc(workspaceId: string, docId: string) {
    const agent = this.agent$.value;
    if (!agent) return;
    await this.store.revokeDoc(workspaceId, docId, agent.id);
    await this.revalidate(workspaceId);
  }
}
