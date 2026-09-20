/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useQuery = vi.fn();

vi.mock('@affine/admin/use-query', () => ({
  useQuery: (...args: unknown[]) => useQuery(...args),
}));

const { WorkspacePicker } = await import('./workspace-picker');

const openPicker = () => {
  fireEvent.click(
    screen.getByRole('button', {
      name: /select workspaces|workspaces? selected/i,
    })
  );
};

describe('WorkspacePicker', () => {
  beforeEach(() => {
    useQuery.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  test('lists the workspaces the server returns', () => {
    useQuery.mockReturnValue({
      data: {
        adminWorkspaceOptions: [
          { id: 'ws-1', name: 'DroneAid France' },
          { id: 'ws-2', name: null },
        ],
      },
    });

    render(<WorkspacePicker selected={[]} onChange={vi.fn()} />);
    openPicker();

    expect(screen.getByText('DroneAid France')).toBeTruthy();
    expect(screen.getByText('Untitled workspace')).toBeTruthy();
    expect(screen.getByText('ws-1')).toBeTruthy();
  });

  test('a failing query degrades to a message instead of unmounting', () => {
    useQuery.mockImplementation(() => {
      throw new Error('Resource not found.');
    });

    render(<WorkspacePicker selected={[]} onChange={vi.fn()} />);
    openPicker();

    expect(screen.getByText(/could not load the workspace list/i)).toBeTruthy();
    expect(screen.getByText(/Resource not found\./)).toBeTruthy();
    // The rest of the picker is still mounted and usable.
    expect(screen.getByPlaceholderText('Add by workspace id')).toBeTruthy();
  });

  test('a workspace id can be added by hand when the list is unavailable', () => {
    useQuery.mockImplementation(() => {
      throw new Error('Resource not found.');
    });
    const onChange = vi.fn();

    render(<WorkspacePicker selected={['ws-1']} onChange={onChange} />);
    openPicker();

    fireEvent.change(screen.getByPlaceholderText('Add by workspace id'), {
      target: { value: '  ws-2  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onChange).toHaveBeenCalledWith(['ws-1', 'ws-2']);
  });

  test('an id that is already selected is not added twice', () => {
    useQuery.mockReturnValue({ data: { adminWorkspaceOptions: [] } });
    const onChange = vi.fn();

    render(<WorkspacePicker selected={['ws-1']} onChange={onChange} />);
    openPicker();

    fireEvent.change(screen.getByPlaceholderText('Add by workspace id'), {
      target: { value: 'ws-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  test('a selected id stays visible even when the list does not know it', () => {
    useQuery.mockReturnValue({
      data: { adminWorkspaceOptions: [{ id: 'ws-1', name: 'Kept' }] },
    });

    render(<WorkspacePicker selected={['ws-gone']} onChange={vi.fn()} />);

    expect(screen.getByText('ws-gone')).toBeTruthy();
    expect(screen.getByText('1 workspace selected')).toBeTruthy();
  });
});
