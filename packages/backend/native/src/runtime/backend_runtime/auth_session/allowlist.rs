//! Email domain allowlist matching.
//!
//! The same rules are implemented on the TypeScript side in
//! `packages/backend/server/src/core/auth/email-allowlist.ts`. The two
//! implementations must agree — the admin panel validates against that one,
//! while the sign-up paths below enforce this one.
//!
//! Rules:
//!   - An empty allowlist permits every domain.
//!   - Matching is case-insensitive and ignores surrounding whitespace.
//!   - `example.com` matches that domain and nothing else.
//!   - `*.example.com` matches the apex `example.com` and every subdomain
//!     beneath it, at any depth (`a.example.com`, `a.b.example.com`).

/// Returns the lowercased domain part of an email address, if there is one.
fn extract_domain(email: &str) -> Option<String> {
  let (_, domain) = email.rsplit_once('@')?;
  let domain = domain.trim().to_ascii_lowercase();
  if domain.is_empty() { None } else { Some(domain) }
}

fn matches_domain(domain: &str, pattern: &str) -> bool {
  let normalized = pattern.trim().to_ascii_lowercase();
  if normalized.is_empty() {
    return false;
  }

  if let Some(base) = normalized.strip_prefix("*.") {
    if base.is_empty() {
      return false;
    }
    // The wildcard covers the apex domain as well as any depth of subdomain.
    return domain == base || domain.ends_with(&format!(".{base}"));
  }

  domain == normalized
}

/// Whether `email` is permitted by `allowed_domains`.
///
/// An empty `allowed_domains` disables the allowlist and permits everything.
pub(crate) fn email_domain_allowed(email: &str, allowed_domains: &[String]) -> bool {
  if allowed_domains.is_empty() {
    return true;
  }

  let Some(domain) = extract_domain(email) else {
    return false;
  };

  allowed_domains
    .iter()
    .any(|pattern| matches_domain(&domain, pattern))
}

#[cfg(test)]
mod tests {
  use super::email_domain_allowed;

  fn list(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
  }

  #[test]
  fn empty_allowlist_permits_everything() {
    assert!(email_domain_allowed("someone@anywhere.test", &[]));
  }

  #[test]
  fn exact_domain_matches_only_itself() {
    let allowed = list(&["example.com"]);
    assert!(email_domain_allowed("a@example.com", &allowed));
    assert!(!email_domain_allowed("a@sub.example.com", &allowed));
    assert!(!email_domain_allowed("a@notexample.com", &allowed));
    // Suffix collision must not match.
    assert!(!email_domain_allowed("a@evil-example.com", &allowed));
  }

  #[test]
  fn wildcard_matches_apex_and_any_depth() {
    let allowed = list(&["*.example.com"]);
    assert!(email_domain_allowed("a@example.com", &allowed));
    assert!(email_domain_allowed("a@sub.example.com", &allowed));
    assert!(email_domain_allowed("a@deep.sub.example.com", &allowed));
    assert!(!email_domain_allowed("a@example.com.evil.test", &allowed));
    // A domain merely ending in the same text is not a subdomain.
    assert!(!email_domain_allowed("a@evilexample.com", &allowed));
  }

  #[test]
  fn matching_is_case_and_whitespace_insensitive() {
    let allowed = list(&["  Example.COM  "]);
    assert!(email_domain_allowed("Someone@EXAMPLE.com", &allowed));
  }

  #[test]
  fn malformed_addresses_are_rejected_when_allowlist_is_active() {
    let allowed = list(&["example.com"]);
    assert!(!email_domain_allowed("no-at-sign", &allowed));
    assert!(!email_domain_allowed("trailing@", &allowed));
  }

  #[test]
  fn plus_addressing_and_multiple_at_signs_use_the_last_domain() {
    let allowed = list(&["example.com"]);
    assert!(email_domain_allowed("user+tag@example.com", &allowed));
    // Only the final @ delimits the domain.
    assert!(email_domain_allowed("weird@local@example.com", &allowed));
  }

  #[test]
  fn any_matching_entry_permits() {
    let allowed = list(&["first.test", "*.example.com"]);
    assert!(email_domain_allowed("a@first.test", &allowed));
    assert!(email_domain_allowed("a@sub.example.com", &allowed));
    assert!(!email_domain_allowed("a@third.test", &allowed));
  }
}
