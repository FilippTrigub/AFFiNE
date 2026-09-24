import { EventBus } from '../../../base';
import { BackendRuntimeProvider } from '../../../core/backend-runtime';
import { CommentService } from '../../../core/comment';
import {
  DocReader,
  DocWriter,
  PgWorkspaceDocStorageAdapter,
  WorkspaceYjsMutator,
} from '../../../core/doc';
import { NotificationService } from '../../../core/notification/service';
import {
  type DocAction,
  PermissionAccess,
  type WorkspaceAction,
} from '../../../core/permission';
import { RealtimePublisher } from '../../../core/realtime';
import { WorkspaceBlobStorage } from '../../../core/storage';
import { DocRole, Models } from '../../../models';
import { DocumentRetrievalService } from '../../retrieval/document';

export interface McpToolDeps {
  ac: PermissionAccess;
  models: Models;
  reader: DocReader;
  writer: DocWriter;
  retrieval: DocumentRetrievalService;
  yjs: WorkspaceYjsMutator;
  storage: PgWorkspaceDocStorageAdapter;
  runtime: BackendRuntimeProvider;
  comments: CommentService;
  notifications: NotificationService;
  realtime: RealtimePublisher;
  blobs: WorkspaceBlobStorage;
  event: EventBus;
}

/**
 * Doc actions an agent may attempt with any grant at all. Everything else needs
 * a grant of at least the role named in `AGENT_MIN_ROLE`.
 */
const AGENT_READ_ACTIONS = new Set<DocAction>([
  'Doc.Read',
  'Doc.Copy',
  'Doc.Duplicate',
  'Doc.Properties.Read',
  'Doc.Comments.Read',
  'Doc.History.Read',
]);
const AGENT_MIN_ROLE: Partial<Record<DocAction, DocRole>> = {
  'Doc.Comments.Create': DocRole.Commenter,
};

export class McpToolContext {
  constructor(
    readonly userId: string,
    readonly workspaceId: string,
    /**
     * For a workspace agent, its explicit `doc_grants` rows are the exhaustive
     * list of what it may touch, and a doc with no grant is invisible to it.
     * `null` for a human: their own permissions govern.
     */
    readonly agentGrants: Map<string, DocRole> | null,
    readonly deps: McpToolDeps
  ) {}

  get isAgent() {
    return this.agentGrants !== null;
  }

  agentMayRead(docId: string) {
    return !this.agentGrants || this.agentGrants.has(docId);
  }

  agentMayWrite(docId: string) {
    return (
      !this.agentGrants ||
      (this.agentGrants.get(docId) ?? DocRole.None) >= DocRole.Editor
    );
  }

  /**
   * The agent containment rule first, then the permission engine. A `false`
   * must be reported to the caller as "not found", so an agent cannot probe for
   * documents it was not granted.
   */
  async canDoc(docId: string, action: DocAction) {
    if (this.agentGrants) {
      const role = this.agentGrants.get(docId);
      if (role === undefined) return false;
      if (!AGENT_READ_ACTIONS.has(action)) {
        const min = AGENT_MIN_ROLE[action] ?? DocRole.Editor;
        if (role < min) return false;
      }
    }
    return await this.deps.ac
      .user(this.userId)
      .workspace(this.workspaceId)
      .doc(docId)
      .can(action);
  }

  async canWorkspace(action: WorkspaceAction) {
    return await this.deps.ac
      .user(this.userId)
      .workspace(this.workspaceId)
      .can(action);
  }

  async assertWorkspace(action: WorkspaceAction) {
    await this.deps.ac
      .user(this.userId)
      .workspace(this.workspaceId)
      .assert(action);
  }

  /**
   * An agent sees only what it holds a grant on, so without this it could not
   * read back a document it just wrote. Editor, not Manager: it may revise its
   * own work, not administer it.
   */
  async grantAgentCreatedDoc(docId: string) {
    if (!this.agentGrants) return;
    await this.deps.models.docUser.set(
      this.workspaceId,
      docId,
      this.userId,
      DocRole.Editor
    );
    this.agentGrants.set(docId, DocRole.Editor);
  }
}
