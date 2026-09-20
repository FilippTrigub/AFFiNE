import { describe, expect, test } from 'vitest';

import {
  type AllowlistRule,
  createRule,
  describePattern,
  parseAllowlist,
  serializeAllowlist,
  validateRules,
} from './model';

const rule = (overrides: Partial<Omit<AllowlistRule, 'id'>>) =>
  createRule(overrides);

describe('parseAllowlist', () => {
  test('reads both entry shapes', () => {
    expect(
      parseAllowlist([
        'example.com',
        { pattern: '*.example.org', workspaces: ['ws-1'], role: 'Admin' },
      ])
    ).toMatchObject([
      { pattern: 'example.com', workspaces: [], role: 'Collaborator' },
      { pattern: '*.example.org', workspaces: ['ws-1'], role: 'Admin' },
    ]);
  });

  test('defaults a missing or unknown role to Collaborator', () => {
    expect(
      parseAllowlist([
        { pattern: 'a.com', workspaces: ['ws-1'] },
        { pattern: 'b.com', workspaces: ['ws-1'], role: 'Owner' as any },
      ]).map(entry => entry.role)
    ).toEqual(['Collaborator', 'Collaborator']);
  });

  test('drops unusable entries instead of throwing', () => {
    expect(parseAllowlist([null, 42, { workspaces: [] }])).toEqual([]);
    expect(parseAllowlist('not json at all')).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  test('trims workspace ids and drops empty ones', () => {
    expect(
      parseAllowlist([{ pattern: 'a.com', workspaces: [' ws-1 ', '', 'ws-2'] }])
    ).toMatchObject([{ workspaces: ['ws-1', 'ws-2'] }]);
  });

  test('gives every row a distinct id', () => {
    const [first, second] = parseAllowlist(['a.com', 'a.com']);
    expect(first.id).not.toBe(second.id);
  });
});

describe('serializeAllowlist', () => {
  test('writes a bare string when the rule grants nothing', () => {
    expect(serializeAllowlist([rule({ pattern: ' example.com ' })])).toEqual([
      'example.com',
    ]);
  });

  test('writes the object form when the rule grants workspaces', () => {
    expect(
      serializeAllowlist([
        rule({ pattern: 'example.com', workspaces: ['ws-1'], role: 'Admin' }),
      ])
    ).toEqual([
      { pattern: 'example.com', workspaces: ['ws-1'], role: 'Admin' },
    ]);
  });

  test('round-trips a stored value unchanged', () => {
    const stored = [
      'drone-aid.fr',
      { pattern: '*.drone-aid.fr', workspaces: ['ws-1'], role: 'Collaborator' },
    ];
    expect(serializeAllowlist(parseAllowlist(stored))).toEqual(stored);
  });
});

describe('describePattern', () => {
  test('says nothing about an empty pattern', () => {
    expect(describePattern('   ')).toBeNull();
  });

  test('reads a bare domain as exact', () => {
    expect(describePattern('Example.com')).toEqual({
      text: 'Admits every address at example.com, but not at its subdomains.',
      invalid: false,
    });
  });

  test('reads a wildcard as covering the apex too', () => {
    expect(describePattern('*.example.com')?.text).toContain(
      'any subdomain of it'
    );
  });

  test('reads an address as itself', () => {
    expect(describePattern('someone@example.com')).toEqual({
      text: 'Admits someone@example.com and nobody else.',
      invalid: false,
    });
  });

  test('flags the patterns the server can never match', () => {
    expect(describePattern('*@example.com')?.invalid).toBe(true);
    expect(describePattern('*.')?.invalid).toBe(true);
    expect(describePattern('ex*ample.com')?.invalid).toBe(true);
  });
});

describe('validateRules', () => {
  test('accepts an empty list, which disables the allowlist', () => {
    expect(validateRules([])).toBeUndefined();
  });

  test('rejects a rule with no pattern', () => {
    expect(validateRules([rule({ pattern: '' })])).toBe(
      'Every rule needs a domain or address.'
    );
  });

  test('rejects a rule that can never match', () => {
    expect(validateRules([rule({ pattern: '*@example.com' })])).toBe(
      '"*@example.com" can never match an address.'
    );
  });

  test('accepts well-formed rules', () => {
    expect(
      validateRules([
        rule({ pattern: 'example.com' }),
        rule({ pattern: '*.example.org', workspaces: ['ws-1'] }),
      ])
    ).toBeUndefined();
  });
});
