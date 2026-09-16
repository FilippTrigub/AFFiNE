/**
 * Email domain allowlist matching.
 *
 * The same rules are implemented on the Rust side in
 * `packages/backend/native/src/runtime/backend_runtime/auth_session/allowlist.rs`.
 * The two implementations must agree — the admin panel validates against this one,
 * while the OAuth and magic-link sign-up paths enforce the Rust one.
 *
 * Rules:
 *   - An empty allowlist permits every domain.
 *   - Matching is case-insensitive and ignores surrounding whitespace.
 *   - `example.com` matches that domain and nothing else.
 *   - `*.example.com` matches the apex `example.com` and every subdomain beneath it,
 *     at any depth (`a.example.com`, `a.b.example.com`).
 */

export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) {
    return null;
  }
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

export function isEmailDomainAllowed(
  email: string,
  allowedDomains: string[]
): boolean {
  // An empty allowlist disables the feature entirely.
  if (!allowedDomains.length) {
    return true;
  }

  const domain = extractEmailDomain(email);
  if (!domain) {
    return false;
  }

  return allowedDomains.some(pattern => matchesDomain(domain, pattern));
}

function matchesDomain(domain: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    if (!base) {
      return false;
    }
    // The wildcard covers the apex domain as well as any depth of subdomain.
    return domain === base || domain.endsWith(`.${base}`);
  }

  return domain === normalized;
}
