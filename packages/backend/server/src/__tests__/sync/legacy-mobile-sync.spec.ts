// LEGACY-MOBILE-SHIM: covers the `space:join` protocol still spoken by the
// 0.27.0–0.27.4 mobile store apps. Delete together with the shim in
// core/sync/gateway.ts once 0.27.5 ships to the App Store and Play Store.
import { PrismaClient } from '@prisma/client';
import test, { type ExecutionContext } from 'ava';
import Sinon from 'sinon';
import { io, type Socket as SocketIOClient } from 'socket.io-client';
import { Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';

import { BackendRuntimeProvider } from '../../core/backend-runtime';
import { SpaceSyncGateway } from '../../core/sync/gateway';
import {
  DocRole,
  Models,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from '../../models';
import { addDocToRootDoc } from '../../native';
import { createTestingApp, TestingApp } from '../utils';

type WebsocketError = { name: string; message: string };
type WebsocketResponse<T> = { error: WebsocketError } | { data: T };

const WS_TIMEOUT_MS = 5_000;
const LEGACY_VERSION = '0.27.4';

function unwrapResponse<T>(t: ExecutionContext, res: WebsocketResponse<T>): T {
  if ('data' in res) return res.data;
  t.log(res);
  throw new Error(`Websocket error: ${res.error.name}: ${res.error.message}`);
}

function getErrorResponse<T>(
  t: ExecutionContext,
  res: WebsocketResponse<T>
): WebsocketError {
  if ('error' in res) return res.error;
  t.log(res);
  throw new Error('Expected websocket error response, got data instead');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout (${timeoutMs}ms): ${label}`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createClient(cookie: string): SocketIOClient {
  return io(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { cookie },
  });
}

function waitForConnect(socket: SocketIOClient) {
  if (socket.connected) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    }),
    WS_TIMEOUT_MS,
    'socket connect'
  );
}

function waitForDisconnect(socket: SocketIOClient) {
  if (socket.disconnected) return Promise.resolve();
  return withTimeout(
    new Promise<void>(resolve => socket.once('disconnect', () => resolve())),
    WS_TIMEOUT_MS,
    'socket disconnect'
  );
}

function emitWithAck<T>(socket: SocketIOClient, event: string, data: unknown) {
  return withTimeout(
    new Promise<WebsocketResponse<T>>(resolve => {
      socket.emit(event, data, (res: WebsocketResponse<T>) => resolve(res));
    }),
    WS_TIMEOUT_MS,
    `ack ${event}`
  );
}

/** Resolves with the first event whose payload matches `predicate`. */
function waitForEvent<T>(
  socket: SocketIOClient,
  event: string,
  predicate: (payload: T) => boolean = () => true
) {
  return withTimeout(
    new Promise<T>(resolve => {
      const onEvent = (payload: T) => {
        if (!predicate(payload)) return;
        socket.off(event, onEvent);
        resolve(payload);
      };
      socket.on(event, onEvent);
    }),
    WS_TIMEOUT_MS,
    `event ${event}`
  );
}

function expectNoEvent<T>(
  socket: SocketIOClient,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  durationMs = 300
) {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`Unexpected event received: ${event}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, durationMs);
    socket.on(event, onEvent);
  });
}

async function loginWithCookie() {
  const user = await app.createUser();
  const res = await app
    .POST('/api/auth/sign-in')
    .set('x-affine-version', LEGACY_VERSION)
    .send({ email: user.email, password: user.password })
    .expect(200);
  const cookies = res.get('Set-Cookie') ?? [];
  return { user, cookie: cookies.map(c => c.split(';')[0]).join('; ') };
}

function createYjsUpdateBase64() {
  const doc = new Doc();
  doc.getMap('m').set('k', Math.random().toString());
  return Buffer.from(encodeStateAsUpdate(doc)).toString('base64');
}

async function createSnapshot(
  workspaceId: string,
  docId: string,
  userId: string
) {
  await app.get(PrismaClient).snapshot.create({
    data: {
      id: docId,
      workspaceId,
      blob: Buffer.from(encodeStateAsUpdate(new Doc())),
      state: Buffer.from(encodeStateVector(new Doc())),
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId,
      updatedBy: userId,
    },
  });
}

/**
 * Owner + collaborator in one workspace. `private-doc` is unreadable for the
 * collaborator, `reader-doc` is read-only, `editor-doc` is editable.
 */
async function setupWorkspace() {
  const models = app.get(Models);
  const owner = await loginWithCookie();
  const collaborator = await loginWithCookie();
  const workspace = await models.workspace.create(owner.user.id);
  await models.workspaceUser.set(
    workspace.id,
    collaborator.user.id,
    WorkspaceRole.Collaborator,
    { status: WorkspaceMemberStatus.Accepted }
  );
  const roles: Record<string, DocRole> = {
    'private-doc': DocRole.None,
    'reader-doc': DocRole.Reader,
    'editor-doc': DocRole.Editor,
  };
  for (const [docId, role] of Object.entries(roles)) {
    await models.doc.setDefaultRole(workspace.id, docId, DocRole.None);
    if (role !== DocRole.None) {
      await models.docUser.set(workspace.id, docId, collaborator.user.id, role);
    }
    await createSnapshot(workspace.id, docId, owner.user.id);
  }
  return { owner, collaborator, workspaceId: workspace.id };
}

async function legacyJoin(
  t: ExecutionContext,
  socket: SocketIOClient,
  spaceId: string,
  spaceType = 'workspace'
) {
  await waitForConnect(socket);
  const res = unwrapResponse(
    t,
    await emitWithAck<{ clientId: string; success: boolean }>(
      socket,
      'space:join',
      { spaceType, spaceId, clientVersion: LEGACY_VERSION }
    )
  );
  t.true(res.success);
}

function push(
  socket: SocketIOClient,
  spaceId: string,
  docId: string,
  spaceType = 'workspace'
) {
  return emitWithAck<{ timestamp: number }>(socket, 'space:push-doc-update', {
    spaceType,
    spaceId,
    docId,
    update: createYjsUpdateBase64(),
  });
}

function loadDoc(socket: SocketIOClient, spaceId: string, docId: string) {
  return emitWithAck<{ missing: string; state: string; timestamp: number }>(
    socket,
    'space:load-doc',
    { spaceType: 'workspace', spaceId, docId }
  );
}

let app: TestingApp;
let url: string;
const sockets: SocketIOClient[] = [];

function track(socket: SocketIOClient) {
  sockets.push(socket);
  return socket;
}

test.before(async () => {
  app = await createTestingApp();
  url = app.url();
});

test.beforeEach(async () => {
  await app.initTestingDB();
});

test.afterEach.always(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});

test.after.always(async () => {
  await app.close();
});

test('space:join accepts 0.27.0–0.27.4 clients only', async t => {
  const { user, cookie } = await loginWithCookie();

  for (const clientVersion of ['0.27.0', '0.27.1', '0.27.4']) {
    const socket = track(createClient(cookie));
    await waitForConnect(socket);
    const res = unwrapResponse(
      t,
      await emitWithAck<{ success: boolean }>(socket, 'space:join', {
        spaceType: 'userspace',
        spaceId: user.id,
        clientVersion,
      })
    );
    t.true(res.success, clientVersion);
  }

  for (const clientVersion of ['0.26.7', '0.27.5', 'not-a-version']) {
    const socket = track(createClient(cookie));
    await waitForConnect(socket);
    const disconnected = waitForDisconnect(socket);
    const res = unwrapResponse(
      t,
      await emitWithAck<{ success: boolean }>(socket, 'space:join', {
        spaceType: 'userspace',
        spaceId: user.id,
        clientVersion,
      })
    );
    t.false(res.success, clientVersion);
    await disconnected;
  }
});

test('space:join enforces workspace and userspace access', async t => {
  const { workspaceId } = await setupWorkspace();
  const stranger = await loginWithCookie();
  const other = await loginWithCookie();

  const socket = track(createClient(stranger.cookie));
  await waitForConnect(socket);
  const workspaceError = getErrorResponse(
    t,
    await emitWithAck(socket, 'space:join', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      clientVersion: LEGACY_VERSION,
    })
  );
  t.is(workspaceError.name, 'SPACE_ACCESS_DENIED');

  const userspaceError = getErrorResponse(
    t,
    await emitWithAck(socket, 'space:join', {
      spaceType: 'userspace',
      spaceId: other.user.id,
      clientVersion: LEGACY_VERSION,
    })
  );
  t.is(userspaceError.name, 'SPACE_ACCESS_DENIED');
});

test('legacy socket loads and pushes docs without join-batch, per doc permissions', async t => {
  const { collaborator, workspaceId } = await setupWorkspace();
  const socket = track(createClient(collaborator.cookie));
  await legacyJoin(t, socket, workspaceId);

  unwrapResponse(t, await loadDoc(socket, workspaceId, 'reader-doc'));
  unwrapResponse(t, await loadDoc(socket, workspaceId, 'editor-doc'));

  const unreadable = getErrorResponse(
    t,
    await loadDoc(socket, workspaceId, 'private-doc')
  );
  t.true(unreadable.message.includes('Doc.Read'), unreadable.message);

  const readonlyPush = getErrorResponse(
    t,
    await push(socket, workspaceId, 'reader-doc')
  );
  t.true(readonlyPush.message.includes('Doc.Update'), readonlyPush.message);

  const pushed = unwrapResponse(
    t,
    await push(socket, workspaceId, 'editor-doc')
  );
  t.true(pushed.timestamp > 0);
});

test('legacy socket loses access when removed from the workspace', async t => {
  const { collaborator, workspaceId } = await setupWorkspace();
  const socket = track(createClient(collaborator.cookie));
  await legacyJoin(t, socket, workspaceId);
  unwrapResponse(t, await loadDoc(socket, workspaceId, 'editor-doc'));

  await app.get(Models).workspaceUser.delete(workspaceId, collaborator.user.id);

  const error = getErrorResponse(
    t,
    await loadDoc(socket, workspaceId, 'reader-doc')
  );
  t.is(error.name, 'SPACE_ACCESS_DENIED');
});

test('legacy push succeeds after a doc role upgrade', async t => {
  const { collaborator, workspaceId } = await setupWorkspace();
  const socket = track(createClient(collaborator.cookie));
  await legacyJoin(t, socket, workspaceId);

  getErrorResponse(t, await push(socket, workspaceId, 'reader-doc'));

  await app
    .get(Models)
    .docUser.set(
      workspaceId,
      'reader-doc',
      collaborator.user.id,
      DocRole.Editor
    );

  unwrapResponse(t, await push(socket, workspaceId, 'reader-doc'));
});

test('legacy sockets receive updates for readable docs they never loaded', async t => {
  const { owner, collaborator, workspaceId } = await setupWorkspace();
  const legacyOwner = track(createClient(owner.cookie));
  const legacyCollaborator = track(createClient(collaborator.cookie));
  const batchOwner = track(createClient(owner.cookie));
  await legacyJoin(t, legacyOwner, workspaceId);
  await legacyJoin(t, legacyCollaborator, workspaceId);
  await waitForConnect(batchOwner);
  unwrapResponse(
    t,
    await emitWithAck(batchOwner, 'space:join-batch', {
      spaces: [
        { spaceType: 'workspace', spaceId: workspaceId },
        { spaceType: 'workspace', spaceId: workspaceId, docId: 'editor-doc' },
      ],
      clientVersion: '0.27.5',
    })
  );

  type Broadcast = { docId: string; updates: string[] };
  const isDoc = (docId: string) => (p: Broadcast) => p.docId === docId;

  // legacy -> legacy (never loaded the doc) and legacy -> batch
  const toLegacy = waitForEvent<Broadcast>(
    legacyCollaborator,
    'space:broadcast-doc-updates',
    isDoc('editor-doc')
  );
  const toBatch = waitForEvent<Broadcast>(
    batchOwner,
    'space:broadcast-doc-updates',
    isDoc('editor-doc')
  );
  unwrapResponse(t, await push(legacyOwner, workspaceId, 'editor-doc'));
  const [legacyUpdate] = await Promise.all([toLegacy, toBatch]);
  t.is(legacyUpdate.updates.length, 1);

  // batch -> legacy
  const fromBatch = waitForEvent<Broadcast>(
    legacyOwner,
    'space:broadcast-doc-updates',
    isDoc('editor-doc')
  );
  unwrapResponse(t, await push(batchOwner, workspaceId, 'editor-doc'));
  await fromBatch;

  // a doc created after the legacy socket connected: root doc entry, then doc
  const newRoot = waitForEvent<Broadcast>(
    legacyCollaborator,
    'space:broadcast-doc-updates',
    isDoc(workspaceId)
  );
  const newDoc = waitForEvent<Broadcast>(
    legacyCollaborator,
    'space:broadcast-doc-updates',
    isDoc('brand-new-doc')
  );
  unwrapResponse(
    t,
    await emitWithAck(legacyOwner, 'space:push-doc-update', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: workspaceId,
      update: Buffer.from(
        addDocToRootDoc(Buffer.from([0, 0]), 'brand-new-doc')
      ).toString('base64'),
    })
  );
  unwrapResponse(t, await push(legacyOwner, workspaceId, 'brand-new-doc'));
  await Promise.all([newRoot, newDoc]);

  // unreadable docs are never fanned out
  const noPrivate = expectNoEvent<Broadcast>(
    legacyCollaborator,
    'space:broadcast-doc-updates',
    isDoc('private-doc')
  );
  unwrapResponse(t, await push(legacyOwner, workspaceId, 'private-doc'));
  await noPrivate;
});

test('legacy awareness round trip', async t => {
  const { owner, collaborator, workspaceId } = await setupWorkspace();
  const a = track(createClient(owner.cookie));
  const b = track(createClient(collaborator.cookie));
  await legacyJoin(t, a, workspaceId);
  await legacyJoin(t, b, workspaceId);

  for (const socket of [a, b]) {
    const res = unwrapResponse(
      t,
      await emitWithAck<{ success: boolean }>(socket, 'space:join-awareness', {
        spaceType: 'workspace',
        spaceId: workspaceId,
        docId: 'editor-doc',
        clientVersion: LEGACY_VERSION,
      })
    );
    t.true(res.success);
  }

  const received = waitForEvent<{ awarenessUpdate: string }>(
    b,
    'space:broadcast-awareness-update'
  );
  a.emit('space:update-awareness', {
    spaceType: 'workspace',
    spaceId: workspaceId,
    docId: 'editor-doc',
    awarenessUpdate: 'AQID',
  });
  t.is((await received).awarenessUpdate, 'AQID');

  const reserved = getErrorResponse(
    t,
    await emitWithAck(b, 'space:join-awareness', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: `userdata$${owner.user.id}$${workspaceId}$settings`,
      clientVersion: LEGACY_VERSION,
    })
  );
  t.is(reserved.name, 'SPACE_ACCESS_DENIED');

  const left = unwrapResponse(
    t,
    await emitWithAck<{ success: boolean }>(b, 'space:leave-awareness', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: 'editor-doc',
    })
  );
  t.true(left.success);
});

test('batch clients are not affected by the legacy shim', async t => {
  const { collaborator, workspaceId } = await setupWorkspace();
  const socket = track(createClient(collaborator.cookie));
  await waitForConnect(socket);
  unwrapResponse(
    t,
    await emitWithAck(socket, 'space:join-batch', {
      spaces: [{ spaceType: 'workspace', spaceId: workspaceId }],
      clientVersion: '0.27.5',
    })
  );

  // no lazy subscription for non-legacy sockets
  const error = getErrorResponse(
    t,
    await loadDoc(socket, workspaceId, 'editor-doc')
  );
  t.is(error.name, 'NOT_IN_SPACE');
});

test('a legacy socket that disconnects mid-authorization leaves no subscription', async t => {
  const { owner, collaborator, workspaceId } = await setupWorkspace();
  const batchOwner = track(createClient(owner.cookie));
  const legacy = track(createClient(collaborator.cookie));
  await waitForConnect(batchOwner);
  unwrapResponse(
    t,
    await emitWithAck(batchOwner, 'space:join-batch', {
      spaces: [
        { spaceType: 'workspace', spaceId: workspaceId },
        { spaceType: 'workspace', spaceId: workspaceId, docId: 'editor-doc' },
      ],
      clientVersion: '0.27.5',
    })
  );
  await legacyJoin(t, legacy, workspaceId);

  const gateway = app.get(SpaceSyncGateway) as unknown as {
    activeSocketDocs: Map<string, Set<string>>;
    legacyAuthorizations: Map<string, Promise<void>>;
  };
  const legacyServerId = legacy.id!;
  const runtime = app.get(BackendRuntimeProvider);
  const loadGeneration = runtime.getSyncPermissionGenerationV1.bind(runtime);
  let disconnected: Promise<void> | undefined;
  const stub = Sinon.stub(runtime, 'getSyncPermissionGenerationV1').callsFake(
    async workspace => {
      if (!disconnected) {
        disconnected = waitForDisconnect(legacy);
        legacy.disconnect();
        await disconnected;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return loadGeneration(workspace);
    }
  );
  try {
    // fans out to the legacy socket, whose authorization reads the generation
    unwrapResponse(t, await push(batchOwner, workspaceId, 'editor-doc'));
    const deadline = Date.now() + WS_TIMEOUT_MS;
    while (gateway.legacyAuthorizations.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    stub.restore();
  }

  t.truthy(disconnected);
  t.is(gateway.legacyAuthorizations.size, 0);
  t.false(gateway.activeSocketDocs.has(legacyServerId));
});
