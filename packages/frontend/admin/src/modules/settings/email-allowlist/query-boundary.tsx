import { Component, type ReactNode } from 'react';

type QueryBoundaryProps = {
  /** Shown in place of the children when the query throws. */
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
};

type QueryBoundaryState = { error: Error | null };

/**
 * `@affine/admin/use-query` runs SWR with `suspense: true`, so a failed query is
 * rethrown during render. The admin panel has no error boundary of its own, so
 * without this one a single failing query unmounts the whole app and leaves a
 * blank page. Keep the blast radius at the widget that asked for the data.
 */
export class QueryBoundary extends Component<
  QueryBoundaryProps,
  QueryBoundaryState
> {
  override state: QueryBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): QueryBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    return error ? this.props.fallback(error) : this.props.children;
  }
}
