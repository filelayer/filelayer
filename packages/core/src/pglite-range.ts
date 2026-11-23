// The PGlite versions createTestDb() and quickstart() accept (src/db.ts).
// Its own module so its test can import it without it becoming part of the
// package's API: src/index.ts re-exports db.ts, not this.

/**
 * THE SUPPORTED RANGE, CHECKED WHEN PGLITE IS LOADED, NOT AT INSTALL:
 * `^0.3.11 || ^0.5.8 || ^0.6.0`, the same range `devDependencies` declares.
 *
 * Until 0.35.4 it was `^0.3.11` as an optional `peerDependencies` entry. npm
 * treats an optional peer that IS installed as a constraint, so a project that
 * already had PGlite's `latest` (0.5.x) could not add this package: ERESOLVE,
 * no tree at all, at the first contact. Production installs never need PGlite,
 * so the peer entry protected nobody. It is gone; the whole suite passes on
 * 0.5.8 and on 0.5.16, and CI runs it on PGlite's latest; and the range is
 * enforced here, at the one moment it matters, with an error that names the
 * command that fixes it. 0.4.x is outside it: never tested. 0.6.0, released on
 * 23 November 2026, is inside it from 0.36.1: the whole suite passes on it.
 */
export function pgliteSupported(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== 0) return false;
  return (minor === 3 && patch >= 11) || (minor === 5 && patch >= 8) || minor === 6;
}
