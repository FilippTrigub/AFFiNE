import { PrismaClient } from '@prisma/client';

import { app, e2e, Mockers } from '../test';

async function gql(query: string) {
  const res = await app.POST('/graphql').send({ query }).expect(200);
  return res.body as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions: Record<string, any> }>;
  };
}

const createAgent = (workspaceId: string, email: string) =>
  gql(`
    mutation {
      createWorkspaceAgent(input: {
        workspaceId: "${workspaceId}",
        email: "${email}",
        name: "Doc agent"
      }) { id email name }
    }
  `);

async function adminWithWorkspace() {
  const admin = await app.create(Mockers.User, { feature: 'administrator' });
  await app.login(admin);
  const owner = await app.create(Mockers.User);
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
  });
  return { admin, owner, workspace };
}

e2e('an admin can mint an agent account bound to one workspace', async t => {
  const { workspace } = await adminWithWorkspace();

  const res = await createAgent(
    workspace.id,
    `agent.${workspace.id}@agents.local`
  );
  t.falsy(res.errors);
  const agentId = res.data?.createWorkspaceAgent.id as string;

  const db = app.get(PrismaClient);
  const agent = await db.user.findUniqueOrThrow({ where: { id: agentId } });
  t.is(agent.agentOfWorkspaceId, workspace.id);
  // No mailbox, no password: it can never complete an interactive sign-in.
  t.is(agent.password, null);
  t.is(agent.emailVerifiedAt, null);

  const membership = await db.workspaceMember.findFirstOrThrow({
    where: { workspaceId: workspace.id, userId: agentId },
  });
  // Collaborator ('member'), never owner -- an owner inherits doc Owner
  // unconditionally and could not be excluded from any doc.
  t.is(membership.role, 'member');
});

e2e('an established session is refused once the user is an agent', async t => {
  // Sign in as an ordinary user first, then mark it an agent. This is the
  // defence-in-depth case: even if a credential existed, or Rust issued a
  // session before the flag was set, every authenticated surface refuses it.
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
  t.is(after.errors?.[0]?.extensions?.name, 'AGENT_ACCOUNT_CAN_NOT_SIGN_IN');
  t.falsy(after.data?.currentUser);

  // ...but a public route must still work, or a browser holding the cookie
  // could never reach the sign-in endpoint to become somebody else.
  const human = await app.create(Mockers.User);
  await app.login(human);
  const recovered = await gql(`query { currentUser { id } }`);
  t.is(recovered.data?.currentUser.id, human.id);
});

e2e('a non-admin cannot mint an agent account', async t => {
  const { workspace } = await adminWithWorkspace();
  const outsider = await app.create(Mockers.User);
  await app.login(outsider);

  const res = await createAgent(
    workspace.id,
    `nope.${workspace.id}@agents.local`
  );
  t.truthy(res.errors?.length);
  t.falsy(res.data?.createWorkspaceAgent);
});

e2e('minting an agent for a missing workspace is refused', async t => {
  await adminWithWorkspace();

  const res = await createAgent('does-not-exist', 'ghost@agents.local');
  t.is(res.errors?.[0]?.extensions?.name, 'SPACE_NOT_FOUND');
});
