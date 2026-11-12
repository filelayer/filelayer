# The usage report: what your deployment did, in a file you control

Filelayer sends nothing, ever. There is no telemetry and no background request,
and this command does not add one.

`filelayer usage-report` reads your own database and writes one week of your
deployment's usage, as aggregate counts, to a JSON file on your disk. You read
the file. You decide whether to share it, and if you do, the place to share it
is an [issue on the repository](https://github.com/filelayer/filelayer/issues).
A report you share is what lets us count your deployment as a verified adopter:
Filelayer runs inside your application, so without one we cannot tell that your
deployment exists at all.

The file contains no file names, no user, org, file or grant identifiers, no IP
addresses and no event contents. It contains the fields listed on this page and
nothing else: its shape is `usage-report.schema.json`, which ships in the
package, and the report is checked against it before it is written.

## Before you run it

The command opens its own connection to PostgreSQL, so it needs two things
from the project you run it in:

- **The `pg` driver:** `npm install pg`. It is an optional peer dependency
  (`^8.0.0`): `@filelayer/core` has no runtime dependencies, and the CLI is the
  only part of it that needs a driver.
- **`DATABASE_URL`**, pointing at the PostgreSQL server and database your
  deployment uses, and reachable from where you run the command. CI runs it
  against PostgreSQL 17.

If either is missing, it stops before reading anything and says which one.

**The command does not work with PGlite.** If your Filelayer runs on PGlite
(`Filelayer.quickstart()`, or `createTestDb()` in tests), the database lives
inside your application's process and the command has nothing to connect to.
Build the report from code instead, with `buildUsageReport(db, { week })`: on
an instance from `Filelayer.quickstart()`, `db` is `fl.store.db`; with
`createTestDb()`, it is the `db` that returns. That route is shown below,
under the options.

## Run it

From a project where `@filelayer/core` is installed:

```bash
npx filelayer usage-report
```

Anywhere else: `npx -p @filelayer/core -p pg filelayer usage-report`.

It reads `DATABASE_URL` from the environment, as the rest of the CLI does, and
writes `./filelayer-usage-report-<first 8 characters of install_id>-<week>.json`
for the last complete ISO week (UTC). Then it prints the same JSON, so what you
see is what the file holds.

| Option | What it does |
|---|---|
| `--week YYYY-Www` | Report that ISO week instead, for example `--week 2026-W44`. |
| `--out <path>` | Write the file there instead. |
| `--print` | Print the report and write no file. |

- **It never overwrites a file.** If the file exists, it says so and exits 1.
- **A bad week, or `--week` or `--out` with no value,** exits 2 before it
  connects to anything.
- **The first report writes one row to your database:** a random `install_id`
  in the table `filelayer_install` (schema version 16). That happens on the
  first run with or without `--print`. Every other part of the command only
  reads.

From code, the same report is `buildUsageReport(db, { week })`, where `db` is
your `pg.Pool`, your PGlite instance, or anything else you hand to
`new Filelayer()`. `validateUsageReport(report)` returns the list of ways a
value differs from the schema (empty when it matches). Here on a throwaway
PGlite instance:

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import { strict as assert } from 'node:assert';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
import { buildUsageReport, validateUsageReport, isoWeekOf } from '@filelayer/core';

await fl.files.put(new TextEncoder().encode('hello'), { org: 'acme', owner: 'ana' });

const report = await buildUsageReport(fl.store.db, { week: isoWeekOf(new Date()) });
assert.deepEqual(validateUsageReport(report), []);
assert.equal(report.ops.upload, 1);
assert.equal(report.errors, null);
```

From code, writing the file is yours, and so are the two things the command
does for you: it never overwrites a file, and it shows you what it wrote.

<!-- doccheck: skip reason="writes a file into the working directory, which a documentation check must not do" -->

```ts
import { writeFileSync } from 'node:fs';

const json = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(`filelayer-usage-report-${report.install_id.slice(0, 8)}-${report.week}.json`, json, { flag: 'wx' });
console.log(json);
```

## What a report looks like

One week of a deployment that stored one file and read it once:

```json
{
  "format": 1,
  "install_id": "f6528ef5-5808-45f8-b186-42687ff837cb",
  "week": "2026-W44",
  "lib_version": "<the version you installed>",
  "node_major": 22,
  "storage_kind": ["memory"],
  "schema_version": 16,
  "days_active": 1,
  "ops": {
    "upload": 1,
    "read_allowed": 1,
    "read_denied": 0,
    "share_create": 0,
    "share_revoke": 0,
    "unshare": null,
    "direct_upload": 0,
    "job_run": 0
  },
  "errors": null,
  "first_success_day": 0,
  "scale_bucket": { "files": "1-10", "orgs": "1-10" },
  "notes": ["errors_not_measured", "unshare_not_recorded"]
}
```

## `null` means "not measured", never zero

A field the report cannot measure honestly is `null`, and `notes` says why
with one of seven fixed codes. A `0` is a measured zero: the thing was looked
for and did not happen. Reading a `null` as `0` is the one mistake this format
is built to prevent.

**A `null` always carries its note.** `validateUsageReport()` rejects a report
with a `null` that no note in `notes` explains. Which notes explain which
field is in `usage-report.null-notes.json`, shipped beside the schema. The
schema is plain JSON Schema (draft 2020-12), so a standard validator such as Ajv
compiles it with its default options and checks the shape; the null-to-note
rule is the one check only `validateUsageReport()` makes. In format 1, `errors`
and `ops.unshare` can only be `null`.

To load the schema, ask the package for it. The JSON file ships in the tarball
but is not in the package's `exports`, so
`import '@filelayer/core/usage-report.schema.json'` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. `usageReportSchema()` returns the parsed
schema, and `USAGE_REPORT_SCHEMA_PATH` is the absolute path of the file on disk:

```ts
import { usageReportSchema, USAGE_REPORT_SCHEMA_PATH } from '@filelayer/core';

const schema = usageReportSchema();
assert.equal(schema.$id, 'https://filelayer.dev/usage-report.schema.json');
assert.ok(USAGE_REPORT_SCHEMA_PATH.endsWith('usage-report.schema.json'));
```

With Ajv, which is not a dependency of this package (`npm install ajv`):

<!-- doccheck: skip reason="imports ajv, which this package does not depend on and this checker does not install" -->

```ts
import Ajv2020 from 'ajv/dist/2020.js';
import { usageReportSchema, validateUsageReport } from '@filelayer/core';

const checkShape = new Ajv2020().compile(usageReportSchema());
checkShape(report);           // the shape, as the schema states it
validateUsageReport(report);  // the shape, plus a null always carrying its note
```

| Note | When it appears | Fields that are `null` because of it |
|---|---|---|
| `errors_not_measured` | always, in format 1 | `errors` |
| `unshare_not_recorded` | always, in format 1 | `ops.unshare` |
| `audit_trimmed` | a trim (`trimAuditChain()`) or an erasure (`eraseActorFromAuditChain()`) removed audit events from that week, so any count read from the audit log would be an undercount | every `ops` count except `job_run` and `unshare`, and `days_active`; also `first_success_day` when the first allowed read is no longer in the log |
| `no_files` | the database has no file rows | `storage_kind` |
| `no_successful_read` | no file has ever been read successfully | `first_success_day` |
| `lib_version_unknown` | the installed package's `package.json` has no readable version | `lib_version` |
| `before_install` | the week ended before Filelayer's schema was created in that database, so the deployment did not exist yet. Zeros would read as an idle deployment. A week that overlaps the install is measured | every `ops` count, `job_run` included, `days_active` and `first_success_day` |

Which note may explain which `null`, as the schema states it:

| Field | Notes that explain a `null` |
|---|---|
| `errors` | `errors_not_measured` |
| `ops.unshare` | `unshare_not_recorded` |
| `ops.upload`, `ops.read_allowed`, `ops.read_denied`, `ops.share_create`, `ops.share_revoke`, `ops.direct_upload` | `audit_trimmed`, `before_install` |
| `ops.job_run` | `before_install` |
| `days_active` | `audit_trimmed`, `before_install` |
| `storage_kind` | `no_files` |
| `first_success_day` | `no_successful_read`, `audit_trimmed`, `before_install` |
| `lib_version` | `lib_version_unknown` |

## What each field means

| Field | Meaning |
|---|---|
| `format` | The version of this schema, `1`. A reader that does not know the number should not guess. |
| `install_id` | A random UUID (version 4), generated on the first report and stored in `filelayer_install`. It is linked to nothing else in your database. It stays the same from week to week, which is what lets two reports be read as the same deployment. |
| `week` | The ISO week reported, in UTC, as `YYYY-Www`. |
| `lib_version` | The installed version of `@filelayer/core`. |
| `node_major` | The major version of Node.js that ran the report. |
| `storage_kind` | Every kind of storage your file rows record, as a list drawn from `memory`, `fs`, `s3`, `r2` and `other`. |
| `schema_version` | The highest schema version applied to the database. |
| `days_active` | How many days of that week, 0 to 7, have at least one audit event or one `usage_daily` row. |
| `ops` | Counts for that week, below. |
| `errors` | Not measured in format 1, so always `null`. |
| `first_success_day` | Days from the schema being created to the first file read that was allowed, ever (not only in that week). `0` means the same day. |
| `scale_bucket.files`, `scale_bucket.orgs` | How many file rows and orgs the database holds when the report runs, as one of `0`, `1-10`, `11-1k`, `1k-100k`, `>100k`. A range, not the number. |
| `notes` | The reasons for every `null`, from the table above. |

The `ops` counts come from rows the library already writes. Each is one audit
action and decision, counted over the week:

| `ops` field | Counted from |
|---|---|
| `upload` | `file.create`, allowed. Every file created, direct uploads included. |
| `read_allowed` | `file.read`, allowed. A redirect delivery is counted once, on its `file.read`. |
| `read_denied` | `file.read`, denied, and `file.access`, denied. A file operation by an identity your deployment has never seen is refused before any file is looked up and recorded as `file.access`; most of those are reads, and the audit row cannot say which ones are not, so all of them are counted here. |
| `share_create` | `grant.create`, allowed. |
| `share_revoke` | `grant.revoke`, allowed. |
| `unshare` | Always `null` (`unshare_not_recorded`): `unshare()` writes one `grant.revoke` per grant it removes and nothing of its own, so its revocations are inside `share_revoke` and cannot be counted apart. |
| `direct_upload` | `file.upload_complete`, allowed: direct uploads that finished. |
| `job_run` | Rows in `job_run` that finished during the week: background jobs, run directly or through `runMaintenance()`. This one is read from `job_run`, not from the audit log, so a trim never makes it `null`; a week before the install does (`before_install`). |

## What it does not measure

- **Errors.** Nothing records an error anywhere a report could read it, so
  `errors` is always `null` in format 1. A deployment that is failing and a
  deployment that is not look the same in this report.
- **`unshare()` apart from other revocations.** See `ops.unshare` above.

Both are in [LIMITATIONS.md](../LIMITATIONS.md).
