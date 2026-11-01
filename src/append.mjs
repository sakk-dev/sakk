// SPDX-License-Identifier: Apache-2.0
//
// Shared by the ledger (alerts) and the policy kernel (decision log), which
// must not import each other.

import {
  closeSync,
  constants as fsc,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Append without following a symlink planted at a guessable name (F15 class, review S4). */
export function appendNoFollow(path, text) {
  const fd = openSync(
    path,
    fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | (fsc.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const buf = Buffer.from(text);
    let w = 0;
    while (w < buf.length) w += writeSync(fd, buf, w, buf.length - w);
  } finally {
    closeSync(fd);
  }
}

/**
 * Durable, replace-free file write for the ledger and its cold trail: an
 * unguessable O_EXCL temp (no write THROUGH a planted symlink), every byte
 * accounted for (writeSync can short-write without throwing — a SHORT_WRITE
 * error rather than a truncated file installed), fsync before the atomic
 * rename, then a best-effort directory fsync so the rename itself survives
 * power loss. Throws a plain Error (callers wrap it in their own typed code).
 */
export function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx');
    try {
      const buf = Buffer.from(text);
      let written = 0;
      while (written < buf.length) {
        const w = writeSync(fd, buf, written, buf.length - written);
        if (!(w > 0)) {
          const e = new Error('write made no progress — refusing to install a partial file');
          e.code = 'SHORT_WRITE';
          throw e;
        }
        written += w;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: a dying disk must not replace the real error with a cleanup one
    }
    throw e;
  }
  try {
    const dfd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync is best effort — not every platform allows it */
  }
}
