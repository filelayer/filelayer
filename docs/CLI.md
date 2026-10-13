# The CLI: checking a deployment from a terminal

`filelayer doctor` and `filelayer schema status` answer "is this deployment
wired up correctly?" without a running application. Both are read-only.

```bash
npx filelayer doctor          # Node, DATABASE_URL, and what state the schema is in
npx filelayer schema status   # just the schema, with --json for a script
```

Every problem comes with a line saying what to do about it, and `--json` gives
an agent the same findings in a shape it can branch on.

Two things it will not do, both on purpose. **It takes no credential as an
argument** — there is no `--database-url`, and passing one is an error rather
than being ignored, because a credential on a command line is written to shell
history, visible in `ps`, and echoed by most CI systems. And **it has no
`share`, `download` or `delete`**: reading `DATABASE_URL` is complete authority
over every file and grant, so the CLI cannot enforce permissions and does not
pretend to. A convincing permission check layered on root access is worse than
none, because it reports that something was authorized when nothing was.

With `S3_ENDPOINT` and `S3_BUCKET` set, `doctor` also reports whether the bucket
serves an **unauthenticated** read, which is the most common way everything here
gets undone: Filelayer decides who may be *given* a URL and has no say in who
the object store will answer. The probe writes nothing and uses no credential —
an unsigned GET of a key that does not exist is refused by a private bucket and
answered honestly by a public one — so a check that cannot read a credential
cannot leak one. With those variables unset it says the bucket was not checked
rather than saying nothing.

A refusal is evidence about the bucket root only: a policy that opens one prefix
answers identically and is still public where it matters. And none of this says
whether your credentials work, which needs a signed request and is not here
yet.

`pg` is an optional peer dependency: the CLI is the only part of this package
that needs a driver, and it asks for it by name at runtime.

---

Back to the [README](https://github.com/filelayer/filelayer/blob/main/README.md) · [Quickstart](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) · [what it does not do](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
