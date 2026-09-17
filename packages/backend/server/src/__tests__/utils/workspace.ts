import {
  createWorkspaceMutation,
  publishPageMutation,
  revokePublicPageMutation,
} from '@affine/graphql';
import { PrismaClient } from '@prisma/client';

import { FeatureService } from '../../core/features';
import { WorkspaceRole } from '../../core/permission/types';
import type { WorkspaceType } from '../../core/workspaces';
import { TestingApp } from './testing-app';

/**
 * Fabricates a cloud workspace for tests that need one to exist.
 *
 * `createWorkspace` is `@Admin()`-guarded, so the acting user is promoted to
 * administrator first. Callers of this helper are testing something else -
 * blobs, docs, invites, copilot - and should not have to care about the guard.
 * The guard's own contract is covered by
 * `workspace.e2e.ts > should not let a non-admin create a workspace`.
 */
export async function createWorkspace(app: TestingApp) {
  const userId = app.currentUserId;
  if (userId) {
    await app.get(FeatureService).addAdmin(userId);
  }
  const { createWorkspace } = await app.gql({ query: createWorkspaceMutation });
  await app.get(PrismaClient).snapshot.create({
    data: {
      workspaceId: createWorkspace.id,
      id: createWorkspace.id,
      blob: Buffer.from([0, 0]),
      state: Buffer.from([0, 0]),
      updatedAt: new Date(),
    },
  });
  return createWorkspace;
}

export async function getWorkspacePublicDocs(
  app: TestingApp,
  workspaceId: string
) {
  const res = await app.gql(
    `
      query {
        workspace(id: "${workspaceId}") {
          publicDocs {
            id
            mode
          }
        }
      }
    `
  );

  return res.workspace.publicDocs;
}

export async function getWorkspace(
  app: TestingApp,
  workspaceId: string,
  skip = 0,
  take = 8
): Promise<WorkspaceType> {
  const res = await app.gql(
    `
      query {
        workspace(id: "${workspaceId}") {
          id,
          members(skip: ${skip}, take: ${take}) { id, name, email, permission, inviteId, status }
        }
      }
    `
  );

  return res.workspace;
}

export async function updateWorkspace(
  app: TestingApp,
  workspaceId: string,
  isPublic: boolean
): Promise<boolean> {
  const res = await app.gql(
    `
      mutation {
        updateWorkspace(input: { id: "${workspaceId}", public: ${isPublic} }) {
          public
        }
      }
    `
  );

  return res.updateWorkspace.public;
}

export async function setWorkspaceSharing(
  app: TestingApp,
  workspaceId: string,
  enableSharing: boolean
) {
  const res = await app.gql(
    `
      mutation {
        updateWorkspace(
          input: { id: "${workspaceId}", enableSharing: ${enableSharing} }
        ) {
          enableSharing
        }
      }
    `
  );

  return res.updateWorkspace.enableSharing as boolean;
}

export async function deleteWorkspace(
  app: TestingApp,
  workspaceId: string
): Promise<boolean> {
  const res = await app.gql(
    `
      mutation {
        deleteWorkspace(id: "${workspaceId}")
      }
    `
  );

  return res.deleteWorkspace;
}

export async function publishDoc(
  app: TestingApp,
  workspaceId: string,
  docId: string
) {
  const { publishDoc } = await app.gql({
    query: publishPageMutation,
    variables: { workspaceId, pageId: docId },
  });
  return publishDoc;
}

export async function revokePublicDoc(
  app: TestingApp,
  workspaceId: string,
  docId: string
) {
  const { revokePublicDoc } = await app.gql({
    query: revokePublicPageMutation,
    variables: { workspaceId, pageId: docId },
  });
  return revokePublicDoc;
}

export async function grantMember(
  app: TestingApp,
  workspaceId: string,
  userId: string,
  permission: WorkspaceRole
) {
  const res = await app.gql(
    `
      mutation {
        grantMember(
          workspaceId: "${workspaceId}"
          userId: "${userId}"
          permission: ${WorkspaceRole[permission]}
        )
      }
    `
  );

  return res.grantMember;
}

export async function revokeMember(
  app: TestingApp,
  workspaceId: string,
  userId: string
) {
  const res = await app.gql(
    `
      mutation {
        revokeMember(workspaceId: "${workspaceId}", userId: "${userId}")
      }
    `
  );

  return res.revokeMember;
}
