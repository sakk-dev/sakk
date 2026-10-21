// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the ledger (alerts) and the policy kernel (decision log), which
// must not import each other.

import { closeSync, constants as fsc, openSync, writeSync } from 'node:fs';

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
