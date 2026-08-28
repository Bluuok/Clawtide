/**
 * Time convention (spec §7.7): every timestamp persisted or logged is a UTC
 * ISO-8601 string. Wall-clock reads go through here so grepping for
 * `new Date()` outside this module finds a bug, not a convention.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
