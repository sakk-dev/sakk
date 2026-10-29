#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Test selection for the mutation drill: which files guard one mutant.
//
// The drill used to rerun a whole suite per mutant, so its time grew with
// mutants x suite (F-219). A mutant is killed only when its NAMED test fails,
// and node runs each test file in its own process, so the named test's file
// alone gives the same verdict (Stryker's perTest coverage analysis and PIT's
// test selection do the same).
//
// guardianCommand reads the npm script the mutant names, finds its one
// test-file glob (`<dir>/*.test.mjs`), keeps the files from that glob whose
// source contains the named test's text, and returns the script's own
// command with the glob replaced by those files — so node flags stay the
// suite's. It refuses (DrillSelectionError) when the script is missing, has
// no glob or more than one, the name is empty, or no file contains it: the
// drill then reports DRILL BROKEN, never a pass.
//
// Usage: node scripts/drill-guardians.mjs <repo-dir> <npm-script> <named-test>
// Prints the command on stdout; exits 2 with the reason on stderr.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class DrillSelectionError extends Error {}

const GLOB = /^((?:[\w.-]+\/)*[\w.-]+)\/\*\.test\.mjs$/;
const SAFE_PATH = /^[\w./-]+$/;

export function guardianCommand(root, script, named) {
  if (typeof named !== 'string' || named.trim() === '')
    throw new DrillSelectionError('the mutant names no test');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const command = scripts[script];
  if (typeof command !== 'string')
    throw new DrillSelectionError(`package.json has no "${script}" script`);
  const tokens = command.split(/\s+/);
  const globs = tokens.filter((t) => GLOB.test(t));
  if (globs.length !== 1)
    throw new DrillSelectionError(
      `"${script}" must run exactly one <dir>/*.test.mjs glob, found ${globs.length}`,
    );
  const dir = globs[0].match(GLOB)[1];
  const files = readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${dir}/${f}`)
    .filter((f) => readFileSync(join(root, f), 'utf8').includes(named));
  if (files.length === 0)
    throw new DrillSelectionError(`no file in ${dir}/*.test.mjs contains the test "${named}"`);
  const unsafe = files.find((f) => !SAFE_PATH.test(f));
  if (unsafe)
    throw new DrillSelectionError(`refusing a test path the shell would split: ${unsafe}`);
  return {
    files,
    command: tokens.map((t) => (t === globs[0] ? files.join(' ') : t)).join(' '),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, script, named] = process.argv.slice(2);
  try {
    process.stdout.write(`${guardianCommand(root, script, named).command}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
