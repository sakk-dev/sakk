// SPDX-License-Identifier: Apache-2.0
//
// Loaded first by every `node --test` run in package.json (`--import`). A suite started
// from a git hook inherits GIT_DIR, GIT_INDEX_FILE and friends; a fixture's git in a
// throwaway repository would then act on the real one (F-214: a pre-push run set the
// real repository to bare, rewrote its config and added commits). Deleting them here,
// before the runner starts its test processes, covers every test file, present and future.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
