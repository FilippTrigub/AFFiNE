/**
 * Signup allowlist matching and workspace grants.
 *
 * The matching rules are implemented on the Rust side in
 * `packages/backend/native/src/runtime/backend_runtime/auth_session/allowlist.rs`.
 * The two implementations must agree — the admin panel validates against this one,
 * while the OAuth and magic-link sign-up paths enforce the Rust one. Workspace
 * grants are resolved here only: Rust decides *whether* an address may sign up,
 * TypeScript decides *what* the resulting account is given.
 *
 * An entry is either a bare pattern string, or an object carrying the same
 * pattern plus the workspaces a newly created account should be added to.
 *
 * Matching rules:
 *   - An empty allowlist permits every address.
 *   - Matching is case-insensitive and ignores surrounding whitespace.
 *   - A pattern containing `@` is a full address: it matches that address alone.
 *   - `example.com` matches that domain and nothing else.
 *   - `*.example.com` matches the apex `example.com` and every subdomain beneath
 *     it, at any depth (`a.example.com`, `a.b.example.com`).
 */

import { WorkspaceRole } from '../../models/common/role';

/** Roles an allowlist entry may grant. Owner is deliberately excluded. */
export type AllowlistGrantRole = 'Admin' | 'Collaborator';

export type AllowlistEntryObject = {
  pattern: string;
  workspaces?: string[];
  role?: AllowlistGrantRole;
};

export type AllowlistEntry = string | AllowlistEntryObject;

export type NormalizedAllowlistEntry = {
  pattern: string;
  workspaces: string[];
  role: AllowlistGrantRole;
};

export type WorkspaceGrant = {
  workspaceId: string;
  role: WorkspaceRole;
};

const GRANT_ROLES: Record<AllowlistGrantRole, WorkspaceRole> = {
  Admin: WorkspaceRole.Admin,
  Collaborator: WorkspaceRole.Collaborator,
};

/**
 * Accept both entry shapes and drop anything unusable, so a hand-edited config
 * degrades to "this entry grants nothing" rather than throwing at sign-in time.
 */
export function normalizeAllowlist(
  entries: readonly AllowlistEntry[] | null | undefined
): NormalizedAllowlistEntry[] {
  if (!entries?.length) {
    return [];
  }

  const normalized: NormalizedAllowlistEntry[] = [];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? { pattern: entry } : entry;
    const pattern = raw?.pattern?.trim().toLowerCase();
    if (!pattern) {
      continue;
    }
    const workspaces = (raw.workspaces ?? [])
      .map(id => id.trim())
      .filter(Boolean);
    normalized.push({
      pattern,
      workspaces,
      role: raw.role === 'Admin' ? 'Admin' : 'Collaborator',
    });
  }
  return normalized;
}

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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function matchesPattern(email: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  // A pattern carrying an `@` addresses one person, not a domain. Compared
  // whole so that `a@b@example.com` only ever matches itself.
  if (normalized.includes('@')) {
    return normalizeEmail(email) === normalized;
  }

  const domain = extractEmailDomain(email);
  if (!domain) {
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

/** Every entry that matches `email`. Empty when the allowlist permits by default. */
export function matchAllowlist(
  email: string,
  entries: readonly AllowlistEntry[] | null | undefined
): NormalizedAllowlistEntry[] {
  return normalizeAllowlist(entries).filter(entry =>
    matchesPattern(email, entry.pattern)
  );
}

/**
 * Whether `email` may create an account.
 *
 * An empty allowlist disables the feature entirely. A non-empty one that matches
 * nothing denies — including a list holding only entries that can never match.
 */
export function isEmailDomainAllowed(
  email: string,
  entries: readonly AllowlistEntry[] | null | undefined
): boolean {
  const normalized = normalizeAllowlist(entries);
  if (!normalized.length) {
    return true;
  }

  return normalized.some(entry => matchesPattern(email, entry.pattern));
}

/**
 * The workspaces a newly created `email` account should join, deduplicated.
 *
 * When several matching entries name the same workspace the strongest role wins,
 * so a personal entry can raise what a domain-wide entry already granted.
 */
export function resolveWorkspaceGrants(
  email: string,
  entries: readonly AllowlistEntry[] | null | undefined
): WorkspaceGrant[] {
  const strongest = new Map<string, WorkspaceRole>();

  for (const entry of matchAllowlist(email, entries)) {
    const role = GRANT_ROLES[entry.role];
    for (const workspaceId of entry.workspaces) {
      const current = strongest.get(workspaceId);
      if (current === undefined || role > current) {
        strongest.set(workspaceId, role);
      }
    }
  }

  return [...strongest].map(([workspaceId, role]) => ({ workspaceId, role }));
}
