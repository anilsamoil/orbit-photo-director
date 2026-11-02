export function mailboxKey(email) {
  return email.trim().toLowerCase();
}

export function parseEmailAllowlist(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(',').map((token) => mailboxKey(token)).filter((key) => key.length > 0);
}
