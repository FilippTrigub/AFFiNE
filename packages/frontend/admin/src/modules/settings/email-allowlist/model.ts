/**
 * The shapes `auth.allowedEmailDomains` accepts, and the conversions between
 * them and the editable rows the form renders.
 *
 * Matching itself lives on the server, in two implementations that must agree:
 * `core/auth/email-allowlist.ts` and `native/.../auth_session/allowlist.rs`.
 * Only the descriptions below are duplicated here, never the enforcement.
 */

export type AllowlistGrantRole = 'Admin' | 'Collaborator';

export type AllowlistEntryObject = {
  pattern: string;
  workspaces?: string[];
  role?: AllowlistGrantRole;
};

export type AllowlistEntry = string | AllowlistEntryObject;

/** One row of the form. `id` is local only and never serialized. */
export type AllowlistRule = {
  id: string;
  pattern: string;
  workspaces: string[];
  role: AllowlistGrantRole;
};

let ruleSequence = 0;

export const createRule = (
  rule: Partial<Omit<AllowlistRule, 'id'>> = {}
): AllowlistRule => ({
  id: `allowlist-rule-${ruleSequence++}`,
  pattern: '',
  workspaces: [],
  role: 'Collaborator',
  ...rule,
});

/**
 * Anything unusable is dropped rather than thrown on, so a hand-edited config
 * still opens in the form instead of breaking the settings page.
 */
export const parseAllowlist = (value: unknown): AllowlistRule[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): AllowlistRule[] => {
    const raw: unknown = typeof entry === 'string' ? { pattern: entry } : entry;
    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const { pattern, workspaces, role } = raw as AllowlistEntryObject;
    if (typeof pattern !== 'string') {
      return [];
    }

    return [
      createRule({
        pattern: pattern.trim(),
        workspaces: Array.isArray(workspaces)
          ? workspaces
              .filter(id => typeof id === 'string')
              .map(id => id.trim())
              .filter(Boolean)
          : [],
        role: role === 'Admin' ? 'Admin' : 'Collaborator',
      }),
    ];
  });
};

/**
 * A rule that grants nothing serializes back to a bare string, keeping the
 * stored config as small as the one an admin would have written by hand.
 */
export const serializeAllowlist = (
  rules: readonly AllowlistRule[]
): AllowlistEntry[] =>
  rules.map(rule => {
    const pattern = rule.pattern.trim();
    return rule.workspaces.length
      ? { pattern, workspaces: [...rule.workspaces], role: rule.role }
      : pattern;
  });

/** Plain-language reading of a pattern, or the reason it can never match. */
export const describePattern = (
  pattern: string
): { text: string; invalid: boolean } | null => {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.includes('@')) {
    return normalized.includes('*')
      ? {
          text: 'Wildcards are not supported inside an address, so this matches nobody.',
          invalid: true,
        }
      : { text: `Admits ${normalized} and nobody else.`, invalid: false };
  }

  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    return base
      ? {
          text: `Admits every address at ${base} and at any subdomain of it.`,
          invalid: false,
        }
      : { text: 'A wildcard needs a domain after it.', invalid: true };
  }

  if (normalized.includes('*')) {
    return {
      text: 'A wildcard is only recognised as a leading "*." — this matches nobody.',
      invalid: true,
    };
  }

  return {
    text: `Admits every address at ${normalized}, but not at its subdomains.`,
    invalid: false,
  };
};

/** The one error that must block saving: a rule nobody could ever match. */
export const validateRules = (
  rules: readonly AllowlistRule[]
): string | undefined => {
  if (rules.some(rule => !rule.pattern.trim())) {
    return 'Every rule needs a domain or address.';
  }

  const unmatchable = rules.find(
    rule => describePattern(rule.pattern)?.invalid
  );
  return unmatchable
    ? `"${unmatchable.pattern.trim()}" can never match an address.`
    : undefined;
};
