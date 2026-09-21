/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ErrorBoundary, RouteErrorFallback } from './error-boundary';

const Boom = ({ throws }: { throws: boolean }) => {
  if (throws) {
    throw new Error('Resource not found.');
  }
  return <div>content</div>;
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error; the assertions are the signal here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('renders the children while nothing throws', () => {
    render(
      <ErrorBoundary fallback={() => <div>failed</div>}>
        <Boom throws={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('content')).toBeTruthy();
  });

  test('renders the fallback with the thrown error instead of unmounting', () => {
    render(
      <ErrorBoundary fallback={error => <div>caught: {error.message}</div>}>
        <Boom throws />
      </ErrorBoundary>
    );

    expect(screen.getByText(/caught: Resource not found\./)).toBeTruthy();
  });

  test('wraps a non-Error throw so the fallback always gets a message', () => {
    const Thrower = () => {
      throw 'plain string';
    };

    render(
      <ErrorBoundary fallback={error => <div>caught: {error.message}</div>}>
        <Thrower />
      </ErrorBoundary>
    );

    expect(screen.getByText('caught: plain string')).toBeTruthy();
  });

  test('a changed resetKey clears the error, so navigating away recovers', () => {
    const { rerender } = render(
      <ErrorBoundary
        resetKey="/admin/settings"
        fallback={() => <div>failed</div>}
      >
        <Boom throws />
      </ErrorBoundary>
    );
    expect(screen.getByText('failed')).toBeTruthy();

    rerender(
      <ErrorBoundary
        resetKey="/admin/accounts"
        fallback={() => <div>failed</div>}
      >
        <Boom throws={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('content')).toBeTruthy();
  });

  test('the same resetKey keeps the error, so a failing page does not loop', () => {
    const { rerender } = render(
      <ErrorBoundary
        resetKey="/admin/settings"
        fallback={() => <div>failed</div>}
      >
        <Boom throws />
      </ErrorBoundary>
    );

    rerender(
      <ErrorBoundary
        resetKey="/admin/settings"
        fallback={() => <div>failed</div>}
      >
        <Boom throws={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('failed')).toBeTruthy();
  });

  test('the fallback can retry through the reset callback', () => {
    let throws = true;
    const Retryable = () => <Boom throws={throws} />;

    render(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button
            onClick={() => {
              throws = false;
              reset();
            }}
          >
            retry
          </button>
        )}
      >
        <Retryable />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByText('content')).toBeTruthy();
  });
});

describe('RouteErrorFallback', () => {
  afterEach(() => {
    cleanup();
  });

  test('shows the message and offers a retry', () => {
    const reset = vi.fn();
    render(
      <RouteErrorFallback
        error={new Error('Resource not found.')}
        reset={reset}
      />
    );

    expect(screen.getByText('Resource not found.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalled();
  });
});
