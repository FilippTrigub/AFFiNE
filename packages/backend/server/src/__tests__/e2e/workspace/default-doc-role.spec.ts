import { PermissionAccess } from '../../../core/permission';
import { DocRole, WorkspaceRole } from '../../../models';
import { app, e2e, Mockers } from '../test';

async function gql(query: string) {
  const res = await app.POST('/graphql').send({ query }).expect(200);
  const body = res.body as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions: Record<string, any> }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors[0].message);
  }
  return body.data;
}

const setDefaultRole = (workspaceId: string, role: string) =>
  gql(`
    mutation {
      updateWorkspaceDefaultDocRole(input: {
        workspaceId: "${workspaceId}",
        role: ${role}
      })
    }
  `);

const grantDocRole = (
  workspaceId: string,
  docId: string,
  userId: string,
  role: DocRole
) =>
  gql(`
    mutation {
      grantDocUserRoles(input: {
        workspaceId: "${workspaceId}",
        docId: "${docId}",
        userIds: ["${userId}"],
        role: ${DocRole[role]}
      })
    }
  `);

const can = (userId: string, workspaceId: string, docId: string, action: any) =>
  app
    .get(PermissionAccess)
    .user(userId)
    .workspace(workspaceId)
    .doc(docId)
    .can(action);

/**
 * A doc with no `doc_access_policies` row is the case that falls through to the
 * workspace default -- which is every doc created normally. `Mockers.DocMeta`
 * always writes a per-doc role, so it is deliberately not used here.
 */
async function workspaceWithUngovernedDoc() {
  const owner = await app.signup();
  const member = await app.createUser();
  // `switchUser` only works for a user with an established session.
  await app.login(member);
  await app.switchUser(owner);

  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
  });
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
    type: WorkspaceRole.Collaborator,
  });
  const snapshot = await app.create(Mockers.DocSnapshot, {
    workspaceId: workspace.id,
    user: owner,
  });

  return { owner, member, workspace, docId: snapshot.id };
}

e2e(
  'members default to doc Manager until the workspace says otherwise',
  async t => {
    const { member, workspace, docId } = await workspaceWithUngovernedDoc();

    t.is(
      await app.models.workspaceAccessPolicy.getMemberDefaultDocRole(
        workspace.id
      ),
      'manager'
    );
    t.true(await can(member.id, workspace.id, docId, 'Doc.Read'));
    t.true(await can(member.id, workspace.id, docId, 'Doc.Update'));
  }
);

e2e('a None default denies members every ungoverned doc', async t => {
  const { owner, member, workspace, docId } =
    await workspaceWithUngovernedDoc();

  await setDefaultRole(workspace.id, 'None');

  t.is(
    await app.models.workspaceAccessPolicy.getMemberDefaultDocRole(
      workspace.id
    ),
    'none'
  );
  t.false(await can(member.id, workspace.id, docId, 'Doc.Read'));
  t.false(await can(member.id, workspace.id, docId, 'Doc.Update'));
  // The owner inherits doc Owner unconditionally and cannot be excluded.
  t.true(await can(owner.id, workspace.id, docId, 'Doc.Read'));
});

e2e(
  'an explicit grant still opens a single doc in a None workspace',
  async t => {
    const { owner, member, workspace, docId } =
      await workspaceWithUngovernedDoc();
    await setDefaultRole(workspace.id, 'None');

    await grantDocRole(workspace.id, docId, member.id, DocRole.Reader);
    t.true(await can(member.id, workspace.id, docId, 'Doc.Read'));
    t.false(await can(member.id, workspace.id, docId, 'Doc.Update'));

    await grantDocRole(workspace.id, docId, member.id, DocRole.Editor);
    t.true(await can(member.id, workspace.id, docId, 'Doc.Update'));
    // Editor deliberately stops short of administrating the doc.
    t.false(await can(member.id, workspace.id, docId, 'Doc.Delete'));
    t.false(await can(member.id, workspace.id, docId, 'Doc.Users.Manage'));

    // A second doc stays closed -- the grant is per doc, not workspace-wide.
    const other = await app.create(Mockers.DocSnapshot, {
      workspaceId: workspace.id,
      user: owner,
    });
    t.false(await can(member.id, workspace.id, other.id, 'Doc.Read'));
  }
);

e2e('a collaborator cannot change the workspace default', async t => {
  const { member, workspace } = await workspaceWithUngovernedDoc();

  await app.switchUser(member);
  await t.throwsAsync(setDefaultRole(workspace.id, 'None'));
  t.is(
    await app.models.workspaceAccessPolicy.getMemberDefaultDocRole(
      workspace.id
    ),
    'manager'
  );
});

e2e('Owner and External are rejected as a workspace default', async t => {
  const { workspace } = await workspaceWithUngovernedDoc();

  await t.throwsAsync(setDefaultRole(workspace.id, 'Owner'));
  await t.throwsAsync(setDefaultRole(workspace.id, 'External'));
  t.is(
    await app.models.workspaceAccessPolicy.getMemberDefaultDocRole(
      workspace.id
    ),
    'manager'
  );
});
