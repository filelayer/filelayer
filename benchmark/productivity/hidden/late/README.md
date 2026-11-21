# Attacks written after the freeze

PREREG.md declares that the library was tuned against the 21 shared attacks
(`../../adversarial/attacks.mjs`), so those attacks cannot tell a defence that
generalises from one that was fitted to them. These are the attacks that can.

**Who writes them.** Someone who has not seen Filelayer's code, its
documentation, or the shared attacks, working from `../../contract/` alone.
They are added after the preregistration commit and reported separately from
the 21: they never enter H2 or the "both" block.

**What a file looks like.** Any `*.mjs` in this folder that exports `ATTACKS`,
an array of:

    {
      id: 'L1',                      // unique, L1, L2, ...
      name: 'one line',
      severity: 'critical' | 'high' | 'medium' | 'low',
      async run(impl, w) {           // returns one of the verdicts below
        ...
      },
    }

`impl` is the same adapter the shared attacks use (`../attacks-adapter.mjs`):
`read`, `list`, `del`, `share`, `redeem`, `revoke`, `expireShare`,
`shareState`, `listShares`, `setRole`, `audit`, `auditEvents`, `countAudit`,
`uploadHtml`, `uploadNamed`, all speaking HTTP to the implementation. `w` is
the world of `../client.mjs`: `orgA` (alice owner, adam admin, mallory member,
vera viewer), `orgB` (bob owner, eve member), `docA` and `docA2` uploaded by
alice, `ghostDoc` and `ghostDocs` shaped like real ids, `upload(as, org, name,
type, content)`. Every attack gets a fresh world.

A verdict is `{ verdict: 'defended' | 'BREACH' | 'n/a', detail }`, as in the
shared attacks.
`impl.client` is the raw HTTP client (`call(method, path, { as, body,
headers })`) for anything the adapter does not cover.

**How they run.** `node check.mjs <dir> --late` runs them after the shared
attacks and writes them to `score.json` as `late`; `harness/score.mjs --late`
does it for a whole phase from the snapshots, so they can be added after the
runs. Each late attack has a positive control of its own if it can pass by
refusing everything.
