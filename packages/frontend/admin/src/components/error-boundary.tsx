import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui/button';

type ErrorBoundaryProps = {
  /** Rendered in place of the children. `reset` clears the caught error. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /**
   * Clearing the error when this changes is what makes the boundary recoverable
   * without a page load -- React never resets one on its own. Route-level
   * boundaries pass the current pathname, so navigating away is enough.
   */
  resetKey?: unknown;
  children: ReactNode;
};

type ErrorBoundaryState = { error: Error | null; resetKey: unknown };

const toError = (thrown: unknown) =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

/**
 * `@affine/admin/use-query` runs SWR with `suspense: true`, so a failed query is
 * rethrown during render rather than handed back as an `error` value. Without a
 * boundary above it React unmounts the whole tree and the admin panel goes
 * blank -- no message, no navigation, nothing but a black page.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null, resetKey: undefined };

  static getDerivedStateFromError(thrown: unknown) {
    return { error: toError(thrown) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The panel has no error reporting of its own; the console is what an admin
    // and a bug report can actually reach.
    console.error('Admin panel error', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, this.reset) : this.props.children;
  }
}

/** Full-page fallback for a route that could not render at all. */
export const RouteErrorFallback = ({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) => (
  <div className="flex h-full w-full items-center justify-center p-6">
    <div className="flex max-w-md flex-col items-center gap-3 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        This page could not be loaded. The rest of the admin panel still works.
      </p>
      <pre className="max-h-40 w-full overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
        {error.message}
      </pre>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button type="button" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  </div>
);
