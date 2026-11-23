/**
 * A QUICKSTART SCRIPT EXITS WHEN IT IS DONE.
 *
 * On PGlite 0.5.x any write leaves a timer of about ten seconds pending inside
 * PGlite, so a script that ran `quickstart()`, stored a file and reached its
 * last line then sat for ten seconds before the process exited (measured
 * 2026-11-15: 13 s against 2 s on 0.3.x). `fl.close()` closes the database
 * `quickstart()` created. This file runs on whatever PGlite is installed; CI's
 * `test on the newest PGlite in range` job is the one that runs it on 0.6.x.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');

describe('fl.close()', () => {
  it('lets a quickstart script exit within two seconds of its last line', () => {
    const script = `
      const { Filelayer } = await import(${JSON.stringify(SRC)});
      const fl = await Filelayer.quickstart();
      await fl.files.put(new TextEncoder().encode('hi'), { public: true });
      await fl.close();
      process.stdout.write(String(Date.now()));
    `;
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const exited = Date.now();
    assert.equal(r.status, 0, r.stderr);
    const lastLine = Number(r.stdout.trim());
    assert.ok(Number.isFinite(lastLine), `no timestamp: ${r.stdout} ${r.stderr}`);
    const waited = exited - lastLine;
    assert.ok(waited < 2000, `the process waited ${waited} ms after its last line`);
  });

  it('leaves a database you passed in alone', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://x' });
    await fl.close();
    await fl.close();
    const { rows } = await db.query<{ n: number }>('SELECT 1 AS n');
    assert.equal(rows[0]!.n, 1);
  });
});
