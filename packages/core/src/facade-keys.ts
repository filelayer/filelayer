/**
 * Keys for methods the facade calls on `Filelayer` and nobody else should.
 *
 * Not re-exported by index.ts. A symbol-keyed method is unreachable without
 * the symbol, which is the difference between this and a method named
 * `_internal` that every reader of the type is invited to call.
 */

/**
 * Add or remove a member by their EXTERNAL id, registering the target only
 * once the change is authorized (since 0.37.1). `orgs.setRole` and
 * `orgs.removeMember` used to register the target first, so a stranger's
 * refused call into an org that exists left that user registered and one into
 * a missing org did not, and a later `files.list({ as })` told the two apart.
 */
export const MEMBERSHIP_BY_EXTERNAL_ID: unique symbol = Symbol('filelayer.membershipByExternalId');
