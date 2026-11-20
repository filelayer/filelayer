# Filelayer, the Agent Skill

This plugin installs one skill, `filelayer-integration`, for adding user files to
a SaaS application with [`@filelayer/core`](https://www.npmjs.com/package/@filelayer/core):
private uploads, per-user and per-organization permissions, share links that
expire and can be revoked, and an audit trail of every allowed and refused
access, on the application's own Postgres and S3 or R2 bucket.

The skill first decides whether a library is the right answer at all, then
finds what the project already has, mounts the routes that match its runtime,
and checks the result with `auditIntegration()`. It describes
`@filelayer/core` 0.36.0; if your installed version differs, copy the skill
from `node_modules/@filelayer/core/skills/` instead.

The skill, the library and its MCP server run on your own machines and
infrastructure. They do not collect, store or send any data to Filelayer. The
only network connections they make are to the Postgres database and the S3 or
R2 endpoint you configure, and the credentials you set are used for your own
database and bucket and nothing else.

The library is Apache-2.0: https://github.com/filelayer/filelayer. This folder is
generated from the repository's `skills/filelayer-integration` by
`tools/plugin-folder.mjs`.
