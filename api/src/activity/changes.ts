/**
 * The before → after values of the fields that actually changed, for an audit row.
 * Callers pass only configuration fields (names, flags, numbers): personal data and
 * user-authored text stay out of the audit log.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> | undefined {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (before[k] !== after[k]) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
