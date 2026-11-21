You are working alone in a fresh Linux container. Nobody will answer
questions: make the reasonable choice and keep going.

What you have:

- `/work/contract/`: `openapi.yaml` and `REQUIREMENTS.md`, the specification
  of the service. Where the two disagree, `REQUIREMENTS.md` wins.
- `/work/smoke/smoke.mjs`: a short smoke test. Run it against your server with
  `node /work/smoke/smoke.mjs http://127.0.0.1:<port>`. Passing it does not
  mean you are done: hidden tests check every rule in `REQUIREMENTS.md`,
  including the security ones.
- A PostgreSQL server and an S3-compatible object store, already running. Their
  settings are in the environment (`DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`,
  `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), together with
  `BASE_URL` and `ADMIN_TOKEN`. The hidden tests start your server with other
  values for all of them, so read them from the environment.
- Node.js 22 and npm. The network reaches the npm registry and public
  documentation sites, nothing else.

Your project is `/work/app`. It must start with `npm install` and then
`npm start` in that folder, listen on `PORT`, and need nothing else.

{{ARM}}

Limits: {{LIMITS}}. When you have finished, stop and write `DONE` on its own
line, followed by one paragraph on anything you know is missing or wrong.
