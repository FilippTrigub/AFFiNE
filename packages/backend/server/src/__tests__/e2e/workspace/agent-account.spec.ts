import { PrismaClient } from '@prisma/client';

import { ConfigFactory } from '../../../base/config';
import { WorkspaceMcpProvider } from '../../../plugins/mcp/provider';
import { app, e2e, Mockers } from '../test';

/**
 * The test runtime config file feeds the Rust runtime; the Node `Config` keeps
 * its `mcp.enabled: false` default, and the resolver is behind `@McpEnabled()`.
 */
const enableMcp = () =>
  app.get(ConfigFactory).override({ mcp: { enabled: true } });

async function gql(query: string) {
  const res = await app.POST('/graphql').send({ query }).expect(200);
  return res.body as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions: Record<string, any> }>;
  };
}

/**
 * `Mockers.Workspace` writes rows directly and bypasses `WorkspaceModel.create`,
 * so it never provisions an agent. Provision explicitly rather than patching the
 * mock, which would shift member counts in unrelated suites.
 */
async function workspaceWithAgent(ownerId: string) {
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: ownerId },
  });
  const agent = await app.models.workspace.provisionAgent(workspace.id);
  return { workspace, agent };
}

e2e('creating a workspace provisions exactly one agent', async t => {
  const owner = await app.signup();
  const workspace = await app.models.workspace.create(owner.id);

  const db = app.get(PrismaClient);
  const agents = await db.user.findMany({
    where: { agentOfWorkspaceId: workspace.id },
  });
  t.is(agents.length, 1);
  t.is(agents[0].email, `agent.${workspace.id}@agents.local`);
  t.is(agents[0].password, null);

  const membership = await db.workspaceMember.findFirstOrThrow({
    where: { workspaceId: workspace.id, userId: agents[0].id },
  });
  t.is(membership.role, 'member');
  t.is(membership.state, 'active');
});

e2e('provisioning is idempotent', async t => {
  const owner = await app.signup();
  const workspace = await app.models.workspace.create(owner.id);

  await app.models.workspace.provisionAgent(workspace.id);
  await app.models.workspace.provisionAgent(workspace.id);

  const count = await app.get(PrismaClient).user.count({
    where: { agentOfWorkspaceId: workspace.id },
  });
  t.is(count, 1);
});

e2e('an agent can never hold an interactive session', async t => {
  const user = await app.create(Mockers.User);
  await app.login(user);
  const before = await gql(`query { currentUser { id } }`);
  t.is(before.data?.currentUser.id, user.id);

  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: user.id },
  });
  await app.get(PrismaClient).user.update({
    where: { id: user.id },
    data: { agentOfWorkspaceId: workspace.id },
  });

  const after = await gql(`query { currentUser { id } }`);
  t.falsy(after.data?.currentUser);
  const protectedQuery = await gql(`query { workspaces { id } }`);
  t.is(protectedQuery.errors?.[0]?.extensions?.name, 'AUTHENTICATION_REQUIRED');

  // A public route must still work, or a browser holding the cookie could
  // never reach the sign-in endpoint to become somebody else.
  const human = await app.create(Mockers.User);
  await app.login(human);
  const recovered = await gql(`query { currentUser { id } }`);
  t.is(recovered.data?.currentUser.id, human.id);
});

/**
 * The case the whole feature rests on: with the workspace at its default
 * `manager`, the agent must still only reach documents it was explicitly
 * granted. The permission engine alone cannot express that, so this proves the
 * MCP-boundary containment works.
 */
e2e('an agent reaches only the documents it was granted', async t => {
  const owner = await app.signup();
  const { workspace, agent } = await workspaceWithAgent(owner.id);

  const granted = await app.create(Mockers.DocSnapshot, {
    workspaceId: workspace.id,
    user: owner,
  });
  const ungranted = await app.create(Mockers.DocSnapshot, {
    workspaceId: workspace.id,
    user: owner,
  });

  // The workspace default is untouched -- a human member would read both.
  t.is(
    await app.models.workspaceAccessPolicy.getMemberDefaultDocRole(
      workspace.id
    ),
    'manager'
  );

  const provider = app.get(WorkspaceMcpProvider);
  const readOf = async (docId: string) => {
    const server = await provider.for(agent.id, workspace.id, 'READ_WRITE');
    const tool = server.tools.find(item => item.name === 'read_document')!;
    return await tool.execute(
      { docId },
      { signal: new AbortController().signal }
    );
  };
  const writeOf = async (docId: string) => {
    const server = await provider.for(agent.id, workspace.id, 'READ_WRITE');
    const tool = server.tools.find(item => item.name === 'update_document')!;
    return await tool.execute(
      { docId, content: 'hello' },
      { signal: new AbortController().signal }
    );
  };

  // Nothing granted yet: both docs are invisible.
  t.true((await readOf(granted.id)).isError);
  t.true((await readOf(ungranted.id)).isError);

  await app.models.docUser.set(workspace.id, granted.id, agent.id, 10); // Reader
  t.falsy((await readOf(granted.id)).isError);
  t.true((await readOf(ungranted.id)).isError);
  // Reader is read-only, even with a READ_WRITE credential.
  t.true((await writeOf(granted.id)).isError);

  await app.models.docUser.set(workspace.id, granted.id, agent.id, 20); // Editor
  t.falsy((await writeOf(granted.id)).isError);
  // The other doc stays closed: grants are per document.
  t.true((await writeOf(ungranted.id)).isError);
});

e2e('a workspace admin can mint the agent a credential', async t => {
  enableMcp();
  const owner = await app.signup();
  const { workspace } = await workspaceWithAgent(owner.id);

  const res = await gql(`
    mutation {
      createWorkspaceAgentMcpCredential(input: {
        workspaceId: "${workspace.id}", name: "automation", accessMode: READ_ONLY
      }) { token credential { id status } }
    }
  `);
  t.falsy(res.errors);
  const token = res.data?.createWorkspaceAgentMcpCredential.token as string;
  t.true(token.startsWith('aff_mcp_v1.'));

  const listed = await gql(
    `query { workspaceAgentMcpCredentials(workspaceId: "${workspace.id}") { id } }`
  );
  t.is(listed.data?.workspaceAgentMcpCredentials.length, 1);
});

e2e('a plain collaborator cannot mint the agent a credential', async t => {
  enableMcp();
  const owner = await app.signup();
  const { workspace } = await workspaceWithAgent(owner.id);

  const member = await app.createUser();
  await app.login(member);
  await app.switchUser(owner);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
    type: 1, // Collaborator
  });

  await app.switchUser(member);
  const res = await gql(`
    mutation {
      createWorkspaceAgentMcpCredential(input: {
        workspaceId: "${workspace.id}", name: "nope"
      }) { token }
    }
  `);
  t.truthy(res.errors?.length);
  t.falsy(res.data?.createWorkspaceAgentMcpCredential);
});
