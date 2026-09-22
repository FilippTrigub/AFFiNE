import {
  createWorkspaceAgentMcpCredentialMutation,
  type CreateWorkspaceAgentMcpCredentialMutationVariables,
  type DocRole,
  grantDocUserRolesMutation,
  revokeDocUserRolesMutation,
  revokeWorkspaceAgentMcpCredentialMutation,
  rotateWorkspaceAgentMcpCredentialMutation,
  workspaceAgentDocGrantsQuery,
  workspaceAgentMcpCredentialsQuery,
  workspaceAgentQuery,
} from '@affine/graphql';
import { Store } from '@toeverything/infra';

import type { GraphQLService } from '../services/graphql';

export class WorkspaceAgentStore extends Store {
  constructor(private readonly gqlService: GraphQLService) {
    super();
  }

  async agent(workspaceId: string, signal?: AbortSignal) {
    const data = await this.gqlService.gql({
      query: workspaceAgentQuery,
      variables: { workspaceId },
      context: { signal },
    });
    return data.workspaceAgent;
  }

  async credentials(workspaceId: string, signal?: AbortSignal) {
    const data = await this.gqlService.gql({
      query: workspaceAgentMcpCredentialsQuery,
      variables: { workspaceId },
      context: { signal },
    });
    return data.workspaceAgentMcpCredentials;
  }

  async docGrants(workspaceId: string, signal?: AbortSignal) {
    const data = await this.gqlService.gql({
      query: workspaceAgentDocGrantsQuery,
      variables: { workspaceId },
      context: { signal },
    });
    return data.workspaceAgentDocGrants;
  }

  async createCredential(
    input: CreateWorkspaceAgentMcpCredentialMutationVariables['input']
  ) {
    const data = await this.gqlService.gql({
      query: createWorkspaceAgentMcpCredentialMutation,
      variables: {
        input: {
          workspaceId: input.workspaceId,
          name: input.name,
          accessMode: input.accessMode,
          expirationDays: input.expirationDays,
        },
      },
    });
    return data.createWorkspaceAgentMcpCredential;
  }

  async rotateCredential(
    id: string,
    workspaceId: string,
    expirationDays: number
  ) {
    const data = await this.gqlService.gql({
      query: rotateWorkspaceAgentMcpCredentialMutation,
      variables: { id, workspaceId, expirationDays },
    });
    return data.rotateWorkspaceAgentMcpCredential;
  }

  async revokeCredential(id: string, workspaceId: string) {
    const data = await this.gqlService.gql({
      query: revokeWorkspaceAgentMcpCredentialMutation,
      variables: { id, workspaceId },
    });
    return data.revokeWorkspaceAgentMcpCredential;
  }

  /**
   * Document access reuses the ordinary doc-grant mutations: the agent is just
   * a user id as far as they are concerned, and they already require
   * `Doc.Users.Manage` on each document.
   */
  async grantDoc(
    workspaceId: string,
    docId: string,
    userId: string,
    role: DocRole
  ) {
    await this.gqlService.gql({
      query: grantDocUserRolesMutation,
      variables: { input: { workspaceId, docId, userIds: [userId], role } },
    });
  }

  async revokeDoc(workspaceId: string, docId: string, userId: string) {
    await this.gqlService.gql({
      query: revokeDocUserRolesMutation,
      variables: { input: { workspaceId, docId, userId } },
    });
  }
}
