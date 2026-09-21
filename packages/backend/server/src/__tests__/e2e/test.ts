import { PrismaClient } from '@prisma/client';
import test, { registerCompletionHandler } from 'ava';

import { BackendRuntimeProvider } from '../../core/backend-runtime';
import { Env } from '../../env';
import type { NotificationType, UnionNotification } from '../../models';
import { addDocToRootDoc, mergeUpdatesInApplyWay } from '../../native';
import { sleep } from '../utils';
import { type TestingApp } from './create-app';

export const e2e = test;
// @ts-expect-error created in prelude.ts
export const app: TestingApp = globalThis.app;

registerCompletionHandler(async () => {
  await app.close();
});

export function refreshEnv() {
  globalThis.env = new Env();
}

export async function addDocumentToRoot(workspaceId: string, docId: string) {
  const db = app.get(PrismaClient);
  const where = { workspaceId_id: { workspaceId, id: workspaceId } };
  const root = await db.snapshot.findUniqueOrThrow({ where });
  const rootBlob = Buffer.from(root.blob);
  const update = addDocToRootDoc(rootBlob, docId, docId);
  await db.snapshot.update({
    where,
    data: {
      blob: mergeUpdatesInApplyWay([rootBlob, update]),
      updatedAt: new Date(),
    },
  });
}

export async function reconcileSearchProjection() {
  const runtime = app.get(BackendRuntimeProvider);
  for (let attempt = 0; attempt < 50; attempt++) {
    const reconciled = await runtime.reconcileSearchProjection(1000);
    const status = (await runtime.searchStatus()) as {
      ready?: boolean;
      metrics?: { pendingPublications?: number };
    };
    if (
      reconciled === 0 &&
      status.ready &&
      status.metrics?.pendingPublications === 0
    ) {
      return;
    }
  }
  throw new Error('search projection did not converge');
}

const NOTIFICATION_TIMEOUT_MS = 5000;
const NOTIFICATION_POLL_MS = 25;

/**
 * Notifications are written by an `@OnEvent` handler that the mutation
 * triggering them does not await, so reading straight after the mutation
 * returns is a race -- `findManyByUserId` can legitimately come back empty.
 * Poll until the expected notification lands, rather than asserting against
 * `undefined` and failing as an opaque `TypeError` on property access.
 */
export async function waitForLatestNotification(
  userId: string,
  type: NotificationType,
  timeout = NOTIFICATION_TIMEOUT_MS
): Promise<UnionNotification> {
  const deadline = Date.now() + timeout;
  let latest: UnionNotification | undefined;

  for (;;) {
    [latest] = await app.models.notification.findManyByUserId(userId, {
      includeRead: true,
      first: 1,
      offset: 0,
    });

    if (latest?.type === type) {
      return latest;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeout}ms waiting for a ${type} notification for user ${userId}. ` +
          `Latest notification was ${latest ? latest.type : 'none'}.`
      );
    }

    await sleep(NOTIFICATION_POLL_MS);
  }
}

export * from '../mocks';
export { createApp } from './create-app';
export type { TestingApp };
