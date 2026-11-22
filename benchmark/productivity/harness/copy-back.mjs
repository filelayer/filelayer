// Copying the scorer's output back to the task's directory (score.mjs).
//
// The scorer's directory is writable by the snapshot's server, so what is in
// it is the snapshot's to shape: a link, a FIFO, a directory, a file too big.
// Only regular files are copied: each source is opened with O_NOFOLLOW (and
// O_NONBLOCK, so a FIFO cannot hang the harness) and checked with fstat on
// that same descriptor, so nothing can be swapped between the check and the
// read. The destination is removed first and created with O_EXCL, so a link
// there is never followed either (cold review of 21c4946, I-2 and I-4).

import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const COPY_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Copy `names` from `from` to `to`. A file over the limit is dropped, unless
 * its name is in `truncate`: then its last COPY_LIMIT_BYTES are kept, because
 * the end of a log is what says how it ended (cold review of 21c4946, d).
 * Returns what happened to each name: 'copied', 'truncated', 'missing' or
 * 'refused'.
 */
export function copyBack(from, to, names, { truncate = [] } = {}) {
  const out = {};
  for (const n of names) {
    // What an earlier attempt left is not this attempt's.
    rmSync(join(to, n), { force: true, recursive: true });
    let fd;
    try {
      fd = openSync(join(from, n), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      out[n] = e.code === 'ENOENT' ? 'missing' : 'refused';
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        out[n] = 'refused';
        continue;
      }
      const cut = st.size > COPY_LIMIT_BYTES;
      if (cut && !truncate.includes(n)) {
        out[n] = 'refused';
        continue;
      }
      const start = cut ? st.size - COPY_LIMIT_BYTES : 0;
      const dst = openSync(join(to, n), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        const buf = Buffer.alloc(1024 * 1024);
        let pos = start;
        let left = st.size - start;
        while (left > 0) {
          const got = readSync(fd, buf, 0, Math.min(buf.length, left), pos);
          if (got <= 0) break;
          writeSync(dst, buf, 0, got);
          pos += got;
          left -= got;
        }
      } finally {
        closeSync(dst);
      }
      out[n] = cut ? 'truncated' : 'copied';
    } finally {
      closeSync(fd);
    }
  }
  return out;
}
