/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { EmailAllowlistInput } from './index';

describe('EmailAllowlistInput', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders one row per stored entry', () => {
    render(
      <EmailAllowlistInput
        defaultValue={['drone-aid.fr', { pattern: '*.drone-aid.fr' }]}
        onChange={vi.fn()}
      />
    );

    const patterns = screen
      .getAllByLabelText('Domain or address')
      .map(input => (input as HTMLInputElement).value);
    expect(patterns).toEqual(['drone-aid.fr', '*.drone-aid.fr']);
  });

  test('explains that an empty list lets anyone sign up', () => {
    render(<EmailAllowlistInput defaultValue={[]} onChange={vi.fn()} />);

    expect(screen.getByText(/may create an account/)).toBeTruthy();
  });

  test('emits the stored shape as the pattern is typed', () => {
    const onChange = vi.fn();
    render(<EmailAllowlistInput defaultValue={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(onChange).toHaveBeenLastCalledWith(['']);

    fireEvent.change(screen.getByLabelText('Domain or address'), {
      target: { value: 'drone-aid.fr' },
    });
    expect(onChange).toHaveBeenLastCalledWith(['drone-aid.fr']);
  });

  test('describes what the typed pattern will admit', () => {
    render(
      <EmailAllowlistInput
        defaultValue={['*.drone-aid.fr']}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByText(/at drone-aid\.fr and at any subdomain of it/)
    ).toBeTruthy();
  });

  test('reports a rule that can never match, once the admin has edited', () => {
    const onValidationChange = vi.fn();
    render(
      <EmailAllowlistInput
        defaultValue={[]}
        onChange={vi.fn()}
        onValidationChange={onValidationChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(onValidationChange).toHaveBeenLastCalledWith(
      'Every rule needs a domain or address.'
    );

    fireEvent.change(screen.getByLabelText('Domain or address'), {
      target: { value: '*@drone-aid.fr' },
    });
    expect(onValidationChange).toHaveBeenLastCalledWith(
      '"*@drone-aid.fr" can never match an address.'
    );

    fireEvent.change(screen.getByLabelText('Domain or address'), {
      target: { value: 'drone-aid.fr' },
    });
    expect(onValidationChange).toHaveBeenLastCalledWith(undefined);
  });

  test('stays silent about an untouched form', () => {
    const onValidationChange = vi.fn();
    render(
      <EmailAllowlistInput
        defaultValue={['']}
        onChange={vi.fn()}
        onValidationChange={onValidationChange}
      />
    );

    expect(onValidationChange).toHaveBeenCalledWith(undefined);
    expect(onValidationChange).not.toHaveBeenCalledWith(
      'Every rule needs a domain or address.'
    );
  });

  test('removes a rule', () => {
    const onChange = vi.fn();
    render(
      <EmailAllowlistInput
        defaultValue={['a.example.com', 'b.example.com']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove rule' })[0]);
    expect(onChange).toHaveBeenLastCalledWith(['b.example.com']);
  });

  test('drops the workspace grant when the toggle is switched off', () => {
    const onChange = vi.fn();
    render(
      <EmailAllowlistInput
        defaultValue={[
          { pattern: 'a.example.com', workspaces: ['ws-1'], role: 'Admin' },
        ]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(['a.example.com']);
  });
});
