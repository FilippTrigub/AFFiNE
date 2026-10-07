// @vitest-environment happy-dom

import type { LoaderFunctionArgs, RouteObject } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../desktop/pages/root', () => ({ RootWrapper: () => null }));
vi.mock('../mobile/pages/root', () => ({ RootWrapper: () => null }));
vi.mock(
  '../components/affine/affine-error-boundary/affine-error-fallback',
  () => ({ AffineErrorComponent: () => null })
);

import { topLevelRoutes as desktopRoutes } from '../desktop/router';
import { topLevelRoutes as mobileRoutes } from '../mobile/router';

function findShareLoader(routes: RouteObject[]) {
  const route = routes[0].children?.find(
    child => child.path === '/share/:workspaceId/:pageId'
  );
  if (typeof route?.loader !== 'function') {
    throw new Error('share route loader not found');
  }
  return route.loader;
}

async function runShareRedirect(routes: RouteObject[], url: string) {
  const loader = findShareLoader(routes);
  const response = (await loader({
    params: { workspaceId: 'ws', pageId: 'doc' },
    request: new Request(url),
    context: undefined,
  } as LoaderFunctionArgs)) as Response;
  return response.headers.get('Location');
}

describe.each([
  ['desktop', desktopRoutes],
  ['mobile', mobileRoutes],
])('legacy share route redirect (%s)', (_name, routes) => {
  test('keeps query params when redirecting to the workspace doc', async () => {
    await expect(
      runShareRedirect(
        routes,
        'https://app.affine.pro/share/ws/doc?lang=fr&mode=edgeless'
      )
    ).resolves.toBe('/workspace/ws/doc?lang=fr&mode=edgeless');
  });

  test('redirects without a trailing "?" when there is no query', async () => {
    await expect(
      runShareRedirect(routes, 'https://app.affine.pro/share/ws/doc')
    ).resolves.toBe('/workspace/ws/doc');
  });
});
