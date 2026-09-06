# RFC-001 — Group / Organization Grant Subjects

**Status:** Implemented in 0.3.0. This is the design record for `grant_subject`; the schema comments and `SEMANTICS.md` are the reference.
**Origin:** two independent attempts to build unrelated applications on the library hit the same wall — Filelayer could not express "every member of this organization may access this file."

---

## 1. The problem, precisely

`grant_subject` is `actor | link | anonymous`. Org-wide access exists only as `file.visibility = 'org'`, which applies **only to the file's owning org**. Two consequences:

- **Cross-org group access is inexpressible.** "The company that posted this job may read this CV" has no representation. The only way through was a synthetic actor standing in for each company, plus a table mapping real users onto it — a second identity model living in the application, which is exactly what this library exists to remove.
- **Same-org partial access is inexpressible.** "All admins of this org" or "the finance team" requires per-user fan-out, recomputed on every join and leave.

Fan-out is not an acceptable fix. It makes membership changes eventually consistent with access: between a person leaving an organization and the fan-out completing, they can still read the files. Access that lags the membership that justifies it is the failure this library is built to prevent, so the design has to resolve group membership at decision time.

---

## 2. The reframe

The current three subject types are already a set of principals. We just never said so:

| Subject | The set it denotes |
|---|---|
| `actor` | exactly one principal |
| `link` | whoever holds the secret (bearer) |
| `anonymous` | everyone |

The gap is that there is nothing between "one" and "everyone" except a bearer token. **A grant's subject is a principal set, and group access is the missing middle.** This is a generalization of the existing model, not a new mechanism bolted beside it.

## 3. Proposed model

Add two subject types and one column.

```
grant_subject := actor | org | role | link | anonymous
```

- **`org`** — every member of org O, at any role. New column `subject_org_id`.
- **`role`** — every member of org O at role ≥ R. Reuses `subject_org_id` plus `subject_min_role`.

`org` is `role` with the floor at `viewer`; both are kept because the common case should not require naming a role.

**Breadth ordering** (needed for the escalation rule in §4):

```
actor  ⊂  role  ⊆  org  ⊂  anonymous
link   —  orthogonal (bearer, not identity)
```

**Resolution stays a join, never a materialization.** For principal P and file F, a `role`/`org` grant matches iff P has a live membership in `subject_org_id` at role ≥ `subject_min_role`. One extra join on the grant path. Adding or removing a member changes access on the next request, with no recomputation and no write — the same property that makes revocation immediate.

## 4. Invariants

The first five extend existing properties; the sixth is new and is the reason this is safe.

- **I1 — P3 holds, one level up.** `subject_org_id` must be in the same **project** as the file. Cross-project group grants are unrepresentable, enforced by composite FK, exactly as cross-tenant grants already are. Cross-*org* group grants within a project are **allowed and are the point.**
- **I2 — P7 extends.** A grant is live only while its subject org is live. `grant_scope_is_live` gains one term. Deleting an org kills grants *held by* its members, as it already kills grants *on* its files.
- **I3 — P4 unchanged.** Group grants are ordinary rows: revocable, delegable, transitively killed by revoking an ancestor. No new revocation path.
- **I4 — P5 unchanged.** `via` gains `grant:org` and `grant:role`, so the audit event records which membership conferred access. An auditor can still answer "why did this succeed?"
- **I5 — P1 unchanged.** A group grant is an explicit row. There is still no boolean anywhere that opens a file to a population.
- **I6 — NEW: subject breadth may not be amplified by delegation.**
  - An issuer whose authority is **role-derived** (admin/owner of the file's org) may create any subject type.
  - An issuer whose authority is **grant-derived** may delegate only to `actor` or `link` — never `org`, `role`, or `anonymous`.

  Without I6, a contractor holding one `share` grant could re-grant to an entire organization. Capability attenuation already prevents *doing more*; I6 prevents *reaching more people*. Both dimensions must be attenuated or neither is.

## 5. What this deliberately does not do

- **No custom groups.** Groups are orgs and roles, which already exist. A general group table is the road to the unauditable permission model we keep refusing to build; revisit only with evidence.
- **No nested orgs / hierarchies.** Recursive membership on top of recursive grant liveness is a performance and reasoning cost with no demand behind it.
- **No negative grants / deny rules.** Deny-by-default plus revocation covers the cases; explicit denies make the model non-monotonic and very hard to audit.
- **`file.visibility = 'org'` is retained** as sugar for the owning-org case. It becomes describable as an implicit org grant, which simplifies the mental model.

## 6. Cost

One join on the grant path. Authorization is the dominant work this library does — every read resolves standing before a byte moves, and that walk happens far more often than any storage operation — so a change to the decision path has to be measured rather than assumed. Run `dev:bench` before and after and report the result even when it is unflattering.

Measured outcome: a group-grant decision costs roughly 1.4× an actor-grant decision, and is **independent of organization size** — a 200-member org still resolves through two rows, because membership is joined rather than enumerated. Existing paths regress 2–9%, concentrated in the grant lookup. Authorization that resolves through an org role is unaffected, because standing is settled and returned before any group lookup is issued.

The listing predicate must be extended in lockstep, and the **differential test (`listFiles` set-equality against `authorize()`) must pass over a corpus that includes group grants.** That test is the safety net for this entire change: if the point check and the set query disagree about group membership, that is a leak.

## 7. Does it serve the whole vision?

| Case | Representation |
|---|---|
| Public avatar | `anonymous` grant |
| User-owned private file | owner path |
| Org-wide document | `visibility='org'` or `org` grant |
| "Admins only" | `role` grant, floor `admin` |
| Cross-org access (job board, client portal, supplier) | `org` grant naming the other org |
| External share link | `link` grant |
| Forwarded link | delegated `link` grant, transitively revocable |

Five subject types, one resolution function, one audit vocabulary. No case in the roadmap requires a sixth.
