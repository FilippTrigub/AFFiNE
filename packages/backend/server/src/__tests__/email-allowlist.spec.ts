import test from 'ava';

import { isEmailDomainAllowed } from '../core/auth/email-allowlist';

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
