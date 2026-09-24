import * as Y from 'yjs';

import { ConfigFactory } from '../../../base/config';
import { WorkspaceYjsMutator } from '../../../core/doc';
import { WorkspaceMcpProvider } from '../../../plugins/mcp/provider';
import { app, Mockers } from '../test';

export const enableMcp = () =>
  app.get(ConfigFactory).override({ mcp: { enabled: true } });

export type Mode = 'READ_ONLY' | 'READ_WRITE';

export async function toolNames(
  userId: string,
  workspaceId: string,
  mode: Mode = 'READ_WRITE'
) {
  const server = await app
    .get(WorkspaceMcpProvider)
    .for(userId, workspaceId, mode);
  return server.tools.map(tool => tool.name);
}

export async function callTool(
  userId: string,
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  mode: Mode = 'READ_WRITE'
) {
  const server = await app
    .get(WorkspaceMcpProvider)
    .for(userId, workspaceId, mode);
  const tool = server.tools.find(item => item.name === name);
  if (!tool) throw new Error(`tool ${name} is not listed`);
  const result = await tool.execute(args, {
    signal: new AbortController().signal,
  });
  const text = result.content[0]?.text ?? '';
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

/** Call a tool and fail loudly when it reports an error. */
export async function call(
  userId: string,
  workspaceId: string,
  name: string,
  args: Record<string, unknown>
) {
  const result = await callTool(userId, workspaceId, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.json ?? result.text;
}

/** A workspace with a real root doc, owned by a fresh user. */
export async function ownedWorkspace() {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  return { owner, workspace };
}

export async function loadYDoc(workspaceId: string, docId: string) {
  return await app.get(WorkspaceYjsMutator).load(workspaceId, docId);
}

/** Every `reference` attribute found in the text blocks of a page doc. */
export function referencesIn(doc: Y.Doc) {
  const refs: string[] = [];
  for (const block of doc.getMap<unknown>('blocks').values()) {
    if (!(block instanceof Y.Map)) continue;
    const text = block.get('prop:text');
    if (!(text instanceof Y.Text)) continue;
    for (const op of text.toDelta() as {
      attributes?: { reference?: { pageId: string } };
    }[]) {
      if (op.attributes?.reference) refs.push(op.attributes.reference.pageId);
    }
  }
  return refs;
}
