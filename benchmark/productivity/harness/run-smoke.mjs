#!/usr/bin/env node
// Starts a clean environment, starts the project in <dir>, runs the visible
// smoke test against it. Used to check the smoke test against both references.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEnv, startServer } from './local-env.mjs';

const dir = process.argv[2];
const envH = await startEnv();
let server;
let code = 1;
try {
  server = await startServer(dir, envH.env);
  const smoke = fileURLToPath(new URL('../smoke/smoke.mjs', import.meta.url));
  code = spawnSync(process.execPath, [smoke, server.baseUrl], { stdio: 'inherit' }).status ?? 1;
} finally {
  await server?.stop();
  await envH.stop();
}
process.exit(code);
