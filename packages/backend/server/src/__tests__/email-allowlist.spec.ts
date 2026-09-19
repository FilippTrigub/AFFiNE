import test from 'ava';

import {
  isEmailDomainAllowed,
  resolveWorkspaceGrants,
} from '../core/auth/email-allowlist';
import { WorkspaceRole } from '../models/common/role';

// These cases intentionally mirror the Rust tests in
// packages/backend/native/src/runtime/backend_runtime/auth_session/allowlist.rs.
// The two implementations must agree: this one backs admin-side validation,
// the Rust one enforces the OAuth and magic-link sign-up paths.

test('an empty allowlist permits everything', t => {
  t.true(isEmailDomainAllowed('someone@anywhere.test', []));
});

test('an exact entry matches only that domain', t => {
  const allowed = ['example.com'];
  t.true(isEmailDomainAllowed('a@example.com', allowed));
  t.false(isEmailDomainAllowed('a@sub.example.com', allowed));
  t.false(isEmailDomainAllowed('a@notexample.com', allowed));
  // A suffix collision must not match.
  t.false(isEmailDomainAllowed('a@evil-example.com', allowed));
});

test('a wildcard matches the apex domain and any depth of subdomain', t => {
  const allowed = ['*.example.com'];
  t.true(isEmailDomainAllowed('a@example.com', allowed));
  t.true(isEmailDomainAllowed('a@sub.example.com', allowed));
  t.true(isEmailDomainAllowed('a@deep.sub.example.com', allowed));
  t.false(isEmailDomainAllowed('a@example.com.evil.test', allowed));
  // Ending in the same text is not the same as being a subdomain.
  t.false(isEmailDomainAllowed('a@evilexample.com', allowed));
});

test('matching ignores case and surrounding whitespace', t => {
  t.true(isEmailDomainAllowed('Someone@EXAMPLE.com', ['  Example.COM  ']));
});

test('malformed addresses are rejected while the allowlist is active', t => {
  const allowed = ['example.com'];
  t.false(isEmailDomainAllowed('no-at-sign', allowed));
  t.false(isEmailDomainAllowed('trailing@', allowed));
});

test('only the final @ delimits the domain', t => {
  const allowed = ['example.com'];
  t.true(isEmailDomainAllowed('user+tag@example.com', allowed));
  t.true(isEmailDomainAllowed('weird@local@example.com', allowed));
});

test('any matching entry permits the address', t => {
  const allowed = ['first.test', '*.example.com'];
  t.true(isEmailDomainAllowed('a@first.test', allowed));
  t.true(isEmailDomainAllowed('a@sub.example.com', allowed));
  t.false(isEmailDomainAllowed('a@third.test', allowed));
});

test('an entry with an @ matches that address alone', t => {
  const allowed = ['someone@example.com'];
  t.true(isEmailDomainAllowed('someone@example.com', allowed));
  t.true(isEmailDomainAllowed('  SomeOne@Example.COM  ', allowed));
  // The domain is not opened up by an address entry.
  t.false(isEmailDomainAllowed('other@example.com', allowed));
  // Nor is a longer local part that merely ends in the same text.
  t.false(isEmailDomainAllowed('notsomeone@example.com', allowed));
});

test('an address entry and a domain entry coexist', t => {
  const allowed = ['someone@gmail.com', 'example.com'];
  t.true(isEmailDomainAllowed('someone@gmail.com', allowed));
  t.true(isEmailDomainAllowed('anyone@example.com', allowed));
  t.false(isEmailDomainAllowed('anyone@gmail.com', allowed));
});

test('an address entry compares the whole address', t => {
  // Only the final @ delimits the domain, but an address pattern is matched
  // whole, so this pattern is not read as local part `weird` at `local`.
  const allowed = ['weird@local@example.com'];
  t.true(isEmailDomainAllowed('weird@local@example.com', allowed));
  t.false(isEmailDomainAllowed('local@example.com', allowed));
});

test('a list that can never match denies everything', t => {
  // A non-empty list is an active list, so an entry matching nobody locks
  // sign-up rather than falling back to permit-all.
  t.false(isEmailDomainAllowed('someone@example.com', ['@', ' ']));
});

test('object entries gate exactly as their bare pattern would', t => {
  const allowed = [{ pattern: '*.example.com', workspaces: ['ws-1'] }];
  t.true(isEmailDomainAllowed('a@sub.example.com', allowed));
  t.false(isEmailDomainAllowed('a@other.test', allowed));
});

test('a bare entry grants nothing', t => {
  t.deepEqual(resolveWorkspaceGrants('a@example.com', ['example.com']), []);
});

test('a matching object entry grants its workspaces as Collaborator', t => {
  const allowed = [{ pattern: 'example.com', workspaces: ['ws-1', 'ws-2'] }];
  t.deepEqual(resolveWorkspaceGrants('a@example.com', allowed), [
    { workspaceId: 'ws-1', role: WorkspaceRole.Collaborator },
    { workspaceId: 'ws-2', role: WorkspaceRole.Collaborator },
  ]);
});

test('a non-matching object entry grants nothing', t => {
  const allowed = [{ pattern: 'example.com', workspaces: ['ws-1'] }];
  t.deepEqual(resolveWorkspaceGrants('a@other.test', allowed), []);
});

test('an entry may grant Admin', t => {
  const allowed = [
    {
      pattern: 'boss@example.com',
      workspaces: ['ws-1'],
      role: 'Admin' as const,
    },
  ];
  t.deepEqual(resolveWorkspaceGrants('boss@example.com', allowed), [
    { workspaceId: 'ws-1', role: WorkspaceRole.Admin },
  ]);
});

test('the strongest role wins when entries overlap', t => {
  // A personal entry raises what the domain-wide entry already granted,
  // whichever order they appear in.
  const allowed = [
    { pattern: 'example.com', workspaces: ['ws-1'] },
    {
      pattern: 'boss@example.com',
      workspaces: ['ws-1'],
      role: 'Admin' as const,
    },
  ];
  t.deepEqual(resolveWorkspaceGrants('boss@example.com', allowed), [
    { workspaceId: 'ws-1', role: WorkspaceRole.Admin },
  ]);
  t.deepEqual(resolveWorkspaceGrants('other@example.com', allowed), [
    { workspaceId: 'ws-1', role: WorkspaceRole.Collaborator },
  ]);
});

test('grants from several matching entries are merged', t => {
  const allowed = [
    { pattern: '*.example.com', workspaces: ['ws-shared'] },
    { pattern: 'a@sub.example.com', workspaces: ['ws-personal'] },
  ];
  t.deepEqual(resolveWorkspaceGrants('a@sub.example.com', allowed), [
    { workspaceId: 'ws-shared', role: WorkspaceRole.Collaborator },
    { workspaceId: 'ws-personal', role: WorkspaceRole.Collaborator },
  ]);
});

test('an empty allowlist permits everyone and grants nothing', t => {
  t.true(isEmailDomainAllowed('a@anywhere.test', []));
  t.deepEqual(resolveWorkspaceGrants('a@anywhere.test', []), []);
});
