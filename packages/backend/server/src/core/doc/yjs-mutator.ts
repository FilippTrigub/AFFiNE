import { Injectable } from '@nestjs/common';
import * as Y from 'yjs';

import { EventBus } from '../../base';
import { BackendRuntimeProvider } from '../backend-runtime';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';

export interface YjsMutationOptions {
  /** Actor recorded as the editor and checked for permission. */
  editorId: string;
  /**
   * Doc whose `Doc.Update` permission authorizes the write. Defaults to the
   * written doc. Pass the target page when writing its metadata into a shared
   * table doc (e.g. `docProperties`), as `DocWriter` does.
   */
  permissionDocId?: string;
}

export interface YjsMutationResult<T> {
  result: T;
  /** False when the mutation produced no change, and nothing was pushed. */
  changed: boolean;
}

/**
 * Load a workspace Y.Doc, change it with plain `yjs`, and push only the delta
 * through the same authorized write paths live clients use.
 *
 * - The workspace root doc (`docId === workspaceId`) goes through the
 *   `append_root_update` domain command, which validates root updates and
 *   refuses trash/restore/delete smuggled in as plain edits.
 * - Every other doc goes through `PgWorkspaceDocStorageAdapter.pushDocUpdates`,
 *   which authorizes inside the native runtime.
 *
 * Either way `doc.updates.pushed` is emitted so connected clients see the change
 * live. Concurrent edits are safe: the delta is computed against the loaded
 * state vector and merges as a CRDT update.
 */
@Injectable()
export class WorkspaceYjsMutator {
  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly runtime: BackendRuntimeProvider,
    private readonly event: EventBus
  ) {}

  /** The current state of a doc; an empty Y.Doc when it does not exist yet. */
  async load(workspaceId: string, docId: string): Promise<Y.Doc> {
    const doc = new Y.Doc({ guid: docId });
    const record = await this.storage.getDoc(workspaceId, docId);
    if (record?.bin && !this.storage.isEmptyBin(record.bin)) {
      Y.applyUpdate(doc, record.bin);
    }
    return doc;
  }

  async mutate<T>(
    workspaceId: string,
    docId: string,
    options: YjsMutationOptions,
    fn: (doc: Y.Doc) => T
  ): Promise<YjsMutationResult<T>> {
    const doc = await this.load(workspaceId, docId);
    const before = Y.encodeStateVector(doc);
    let result!: T;
    doc.transact(() => {
      result = fn(doc);
    });
    const delta = Y.encodeStateAsUpdate(doc, before);
    doc.destroy();
    if (this.isNoop(delta)) {
      return { result, changed: false };
    }
    await this.push(workspaceId, docId, delta, options);
    return { result, changed: true };
  }

  /** Push an already-encoded update to a workspace doc and broadcast it. */
  async push(
    workspaceId: string,
    docId: string,
    update: Uint8Array,
    options: YjsMutationOptions
  ) {
    let timestamp: number;
    if (docId === workspaceId) {
      const output = await this.runtime.executeDomainCommandV1({
        command: 'append_root_update',
        actorUserId: options.editorId,
        workspaceId,
        update: Buffer.from(update).toString('base64'),
        assertPermission: true,
      });
      timestamp = new Date(output.timestamp as string).getTime();
    } else {
      timestamp = await this.storage.pushDocUpdates(
        workspaceId,
        docId,
        [update],
        options.editorId,
        undefined,
        'update_doc',
        options.permissionDocId
      );
    }
    this.event.emit('doc.updates.pushed', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId,
      updates: [update],
      timestamp,
      editor: options.editorId,
    });
    return timestamp;
  }

  private isNoop(update: Uint8Array) {
    // An update with no structs and an empty delete set encodes as [0, 0].
    return this.storage.isEmptyBin(update);
  }
}
