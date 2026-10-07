// THE PACKAGE SURFACE. A module that is not re-exported here is not part of it,
// whatever the documentation says.
//
// `errors.ts` was missing from this list until `0.19.1`, and the way that got
// out is worth keeping: `0.19.0` shipped the error catalogue, llms.txt and
// QUICKSTART both told a reader to use it, and `ERROR_CODES` and `isErrorCode`
// were not importable from `@filelayer/core`. `FilelayerError` happened to
// arrive through another module's re-export, so the obvious smoke test passed.
//
// The suite did not catch it because `test/error-catalogue.test.ts` imported
// from `../src/errors.ts` directly. It verified the module and said nothing
// about the package. That is the same mistake `check:suite-runs-from-install`
// exists to prevent one level up: test what ships, not what you have on disk.
export * from './authz.ts';
export * from './db.ts';
export * from './errors.ts';
export * from './audit-integration.ts';
export * from './storage.ts';
export * from './store.ts';
export * from './filelayer.ts';
export * from './simple.ts';
export * from './delivery.ts';
