import { app, e2e, Mockers } from '../test';

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await app.POST('/graphql').send({ query, variables }).expect(200);
  return res.body as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions: Record<string, any> }>;
  };
}

const OPTIONS_QUERY = `query { adminWorkspaceOptions { id name } }`;

e2e(
  'adminWorkspaceOptions should name every workspace on a selfhosted instance',
  async t => {
    const previousDeploymentType = globalThis.env.DEPLOYMENT_TYPE;
    // @ts-expect-error override
    globalThis.env.DEPLOYMENT_TYPE = 'selfhosted';

    try {
      const admin = await app.create(Mockers.User, {
        feature: 'administrator',
      });
      await app.login(admin);

      const owner = await app.create(Mockers.User);
      const workspace = await app.create(Mockers.Workspace, {
        owner: { id: owner.id },
        name: 'Granted workspace',
      });

      // The full admin listing is cloud-only upstream, and stays that way.
      const listing = await gql(
        `query { adminWorkspaces(filter: { first: 10, skip: 0 }) { id } }`
      );
      // `UserFriendlyError` uppercases the type into `extensions` (def.ts:128).
      t.is(listing.errors?.[0]?.extensions?.type, 'RESOURCE_NOT_FOUND');
      t.is(listing.errors?.[0]?.extensions?.name, 'NOT_FOUND');

      const options = await gql(OPTIONS_QUERY);
      t.falsy(options.errors);
      const found = options.data?.adminWorkspaceOptions.find(
        (item: { id: string }) => item.id === workspace.id
      );
      t.truthy(found);
      t.is(found.name, 'Granted workspace');
    } finally {
      // @ts-expect-error override
      globalThis.env.DEPLOYMENT_TYPE = previousDeploymentType;
    }
  }
);

e2e('adminWorkspaceOptions should reject a non-admin user', async t => {
  const user = await app.create(Mockers.User);
  await app.login(user);

  const res = await gql(OPTIONS_QUERY);
  t.truthy(res.errors?.length);
  t.falsy(res.data?.adminWorkspaceOptions);
});
