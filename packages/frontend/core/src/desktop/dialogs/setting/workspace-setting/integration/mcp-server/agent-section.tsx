import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  notify,
  useConfirmModal,
} from '@affine/component';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import type {
  WorkspaceAgentCredential,
  WorkspaceAgentDocGrant,
} from '@affine/core/modules/cloud';
import { WorkspaceAgentService } from '@affine/core/modules/cloud';
import { WorkspaceDialogService } from '@affine/core/modules/dialogs';
import { DocDisplayMetaService } from '@affine/core/modules/doc-display-meta';
import { UserFriendlyError } from '@affine/error';
import type { CreateWorkspaceAgentMcpCredentialMutation } from '@affine/graphql';
import { DocRole, McpAccessMode } from '@affine/graphql';

export type RevealedAgentCredential =
  CreateWorkspaceAgentMcpCredentialMutation['createWorkspaceAgentMcpCredential'];

import { useLiveData, useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

import * as styles from './setting-panel.css';

/** The two rungs an agent may hold. Manager and above are deliberately absent. */
const ACCESS_LEVELS = [
  { role: DocRole.Reader, label: 'Read' },
  { role: DocRole.Editor, label: 'Read & write' },
] as const;

const labelOf = (role: DocRole) =>
  ACCESS_LEVELS.find(level => level.role === role)?.label ?? 'Read';

const DocGrantRow = ({
  grant,
  onChange,
  onRemove,
}: {
  grant: WorkspaceAgentDocGrant;
  onChange: (docId: string, role: DocRole) => void;
  onRemove: (docId: string) => void;
}) => {
  const docDisplayService = useService(DocDisplayMetaService);
  const title = docDisplayService.title$(grant.docId).value;

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>{title}</div>
        <div className={styles.description}>{grant.docId}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Menu
          items={ACCESS_LEVELS.map(level => (
            <MenuItem
              key={level.role}
              selected={level.role === grant.role}
              onSelect={() => onChange(grant.docId, level.role)}
            >
              {level.label}
            </MenuItem>
          ))}
        >
          <MenuTrigger>{labelOf(grant.role)}</MenuTrigger>
        </Menu>
        <Button
          variant="secondary"
          onClick={() => onRemove(grant.docId)}
          data-testid={`agent-doc-remove-${grant.docId}`}
        >
          Remove
        </Button>
      </div>
    </div>
  );
};

/**
 * The agent's own credentials and, below them, exactly which documents it may
 * read or write. Document access is the whole point: the agent reaches nothing
 * in the workspace that is not listed here.
 */
export const WorkspaceAgentSection = ({
  workspaceId,
  onReveal,
}: {
  workspaceId: string;
  onReveal: (revealed: RevealedAgentCredential) => void;
}) => {
  const agentService = useService(WorkspaceAgentService);
  const dialogService = useService(WorkspaceDialogService);
  const { openConfirmModal } = useConfirmModal();

  const agent = useLiveData(agentService.agent$);
  const credentials = useLiveData(agentService.credentials$);
  const docGrants = useLiveData(agentService.docGrants$);

  const grantedIds = useMemo(
    () => (docGrants ?? []).map(grant => grant.docId),
    [docGrants]
  );

  const reportError = useCallback((error: unknown) => {
    notify.error({ error: UserFriendlyError.fromAny(error) });
  }, []);

  const createCredential = useAsyncCallback(async () => {
    try {
      const revealed = await agentService.createCredential({
        workspaceId,
        name: 'Agent token',
        accessMode: McpAccessMode.READ_WRITE,
        expirationDays: 90,
      });
      onReveal(revealed);
    } catch (error) {
      reportError(error);
    }
  }, [agentService, onReveal, reportError, workspaceId]);

  const revokeCredential = useCallback(
    (credential: WorkspaceAgentCredential) => {
      openConfirmModal({
        title: 'Revoke this token?',
        description:
          'Any automation using it stops working immediately. This cannot be undone.',
        confirmText: 'Revoke',
        confirmButtonOptions: { variant: 'error' },
        onConfirm: () => {
          agentService
            .revokeCredential(credential.id, workspaceId)
            .catch(reportError);
        },
      });
    },
    [agentService, openConfirmModal, reportError, workspaceId]
  );

  const changeRole = useCallback(
    (docId: string, role: DocRole) => {
      agentService.grantDoc(workspaceId, docId, role).catch(reportError);
    },
    [agentService, reportError, workspaceId]
  );

  const removeDoc = useCallback(
    (docId: string) => {
      agentService.revokeDoc(workspaceId, docId).catch(reportError);
    },
    [agentService, reportError, workspaceId]
  );

  const pickDocs = useCallback(() => {
    dialogService.open('doc-selector', { init: grantedIds }, selectedIds => {
      if (selectedIds === undefined) return;
      const added = selectedIds.filter(id => !grantedIds.includes(id));
      const removed = grantedIds.filter(id => !selectedIds.includes(id));
      Promise.all([
        // New documents start read-only; widening is a deliberate second step.
        ...added.map(id =>
          agentService.grantDoc(workspaceId, id, DocRole.Reader)
        ),
        ...removed.map(id => agentService.revokeDoc(workspaceId, id)),
      ]).catch(reportError);
    });
  }, [agentService, dialogService, grantedIds, reportError, workspaceId]);

  if (!agent) return null;

  return (
    <>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.title}>Agent</div>
            <div className={styles.description}>
              A non-human identity for automations. It cannot sign in, and it
              reaches only the documents listed below.
            </div>
          </div>
          <Button variant="primary" onClick={createCredential}>
            Create token
          </Button>
        </div>
        {credentials?.length ? (
          credentials.map(credential => (
            <div className={styles.row} key={credential.id}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  {credential.name}
                  <span className={styles.tag}>{credential.status}</span>
                </div>
                <div className={styles.description}>
                  {credential.accessMode} · •••• {credential.fingerprint}
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => revokeCredential(credential)}
              >
                Revoke
              </Button>
            </div>
          ))
        ) : (
          <div className={styles.empty}>
            <div className={styles.description}>
              No tokens. Create one to let an automation reach this workspace.
            </div>
          </div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.title}>Document access</div>
            <div className={styles.description}>
              The agent can reach nothing outside this list, whatever the
              workspace defaults are.
            </div>
          </div>
          <Button variant="secondary" onClick={pickDocs}>
            Add documents
          </Button>
        </div>
        {docGrants?.length ? (
          docGrants.map(grant => (
            <DocGrantRow
              key={grant.docId}
              grant={grant}
              onChange={changeRole}
              onRemove={removeDoc}
            />
          ))
        ) : (
          <div className={styles.empty}>
            <div className={styles.description}>
              No documents. The agent can read nothing in this workspace.
            </div>
          </div>
        )}
      </section>
    </>
  );
};
