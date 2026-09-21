import { Toaster } from '@affine/admin/components/ui/sonner';
import { lazy, ROUTES } from '@affine/routes';
import { withSentryReactRouterV7Routing } from '@sentry/react';
import { type PropsWithChildren, useEffect } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes as ReactRouterRoutes,
  useLocation,
} from 'react-router-dom';
import { toast } from 'sonner';
import { SWRConfig } from 'swr';

import { ErrorBoundary, RouteErrorFallback } from './components/error-boundary';
import { ThemeProvider } from './components/theme-provider';
import { TooltipProvider } from './components/ui/tooltip';
import { isAdmin, useCurrentUser, useServerConfig } from './modules/common';
import { Layout } from './modules/layout';

export const Setup = lazy(
  () => import(/* webpackChunkName: "setup" */ './modules/setup')
);
export const Accounts = lazy(
  () => import(/* webpackChunkName: "accounts" */ './modules/accounts')
);
export const Dashboard = lazy(
  () => import(/* webpackChunkName: "dashboard" */ './modules/dashboard')
);
export const Workspaces = lazy(
  () => import(/* webpackChunkName: "workspaces" */ './modules/workspaces')
);
export const About = lazy(
  () => import(/* webpackChunkName: "about" */ './modules/about')
);
export const Settings = lazy(
  () => import(/* webpackChunkName: "settings" */ './modules/settings')
);
export const Auth = lazy(
  () => import(/* webpackChunkName: "auth" */ './modules/auth')
);

const Routes = window.SENTRY_RELEASE
  ? withSentryReactRouterV7Routing(ReactRouterRoutes)
  : ReactRouterRoutes;

/**
 * Resets on navigation, so a page that failed never traps the whole session --
 * clicking another nav item is enough to recover.
 */
function RouteBoundary({ children }: PropsWithChildren) {
  const location = useLocation();

  return (
    <ErrorBoundary
      resetKey={location.pathname}
      fallback={(error, reset) => (
        <RouteErrorFallback error={error} reset={reset} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function AuthenticatedRoutes() {
  const user = useCurrentUser();

  useEffect(() => {
    if (user && !isAdmin(user)) {
      toast.error('You are not an admin, please login the admin account.');
    }
  }, [user]);

  if (!user || !isAdmin(user)) {
    return <Navigate to="/admin/auth" />;
  }

  return (
    <Layout>
      <RouteBoundary>
        <Outlet />
      </RouteBoundary>
    </Layout>
  );
}

function RootRoutes() {
  const config = useServerConfig();
  const location = useLocation();

  if (!config.initialized && location.pathname !== '/admin/setup') {
    return <Navigate to="/admin/setup" />;
  }

  if (/^\/admin\/?$/.test(location.pathname)) {
    return (
      <Navigate
        to={
          environment.isSelfHosted
            ? ROUTES.admin.accounts
            : ROUTES.admin.dashboard
        }
      />
    );
  }

  return <Outlet />;
}

export const App = () => {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <SWRConfig
          value={{
            revalidateOnFocus: false,
            revalidateOnMount: false,
          }}
        >
          <BrowserRouter basename={environment.subPath}>
            <RouteBoundary>
              <Routes>
                <Route path={ROUTES.admin.index} element={<RootRoutes />}>
                  <Route path={ROUTES.admin.auth} element={<Auth />} />
                  <Route path={ROUTES.admin.setup} element={<Setup />} />
                  <Route element={<AuthenticatedRoutes />}>
                    <Route
                      path={ROUTES.admin.dashboard}
                      element={
                        environment.isSelfHosted ? (
                          <Navigate to={ROUTES.admin.accounts} replace />
                        ) : (
                          <Dashboard />
                        )
                      }
                    />
                    <Route
                      path={ROUTES.admin.accounts}
                      element={<Accounts />}
                    />
                    <Route
                      path={ROUTES.admin.workspaces}
                      element={
                        environment.isSelfHosted ? (
                          <Navigate to={ROUTES.admin.accounts} replace />
                        ) : (
                          <Workspaces />
                        )
                      }
                    />
                    <Route
                      path={ROUTES.admin.ai}
                      element={
                        <Navigate to={ROUTES.admin.settings.index} replace />
                      }
                    />
                    <Route path={ROUTES.admin.about} element={<About />} />
                    <Route
                      path={ROUTES.admin.settings.index}
                      element={<Settings />}
                    />
                  </Route>
                </Route>
              </Routes>
            </RouteBoundary>
          </BrowserRouter>
        </SWRConfig>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
};
