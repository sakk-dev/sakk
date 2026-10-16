// SPDX-License-Identifier: AGPL-3.0-only
//
// Case packs: the gold cases grouped by regulatory requirement, so an
// auditor can ask "show me the evidence for this requirement" and get a run
// plus a per-requirement verdict. A pack is a SELECTION over existing cases
// — it adds no scoring logic and cannot weaken any case.
//
// Honesty is part of the format (review C-3): every requirement carries
// `gaps` (what its cases do NOT show) and every pack carries `not_covered`
// (regulatory themes no case exercises). Both are mandatory arrays.
//
// Verdicts (review C-1): a FAKE-executor run proves only that the harness
// chain works, so its requirements read HARNESS_ONLY — never COVERED. Only a
// REAL run (which the authorization chain admits only with approved gold
// labels) can read COVERED, and only when every backing case ran and
// passed; failed or never-run = NOT_COVERED.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const PACK_SCHEMA = 'sakk-case-pack.v1';
const TOP_KEYS = [
  'schema',
  'id',
  'title',
  'regulator',
  'clause_status',
  'not_covered',
  'requirements',
];
const REQ_KEYS = ['id', 'theme', 'cases', 'evidence', 'gaps'];

export class PackError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const nonEmptyString = (x) => typeof x === 'string' && x.trim() !== '';
const stringArray = (x) => Array.isArray(x) && x.every(nonEmptyString);

/** Validate one parsed pack. `knownCases` maps case id → case definition. */
export function validatePack(doc, file, knownCases) {
  const bad = (why) => {
    throw new PackError('PACK_INVALID', `${file}: ${why}`);
  };
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) bad('root must be an object');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) bad(`unknown key "${k}"`);
  if (doc.schema !== PACK_SCHEMA) bad(`schema must be "${PACK_SCHEMA}"`);
  for (const k of ['id', 'title', 'regulator', 'clause_status'])
    if (!nonEmptyString(doc[k])) bad(`${k} must be a non-empty string`);
  if (`${doc.id}.json` !== file) bad(`id "${doc.id}" must match the file name`);
  if (!stringArray(doc.not_covered))
    bad('not_covered must be an array of strings (empty only if truly nothing is missing)');
  if (!Array.isArray(doc.requirements) || doc.requirements.length === 0)
    bad('requirements must be a non-empty array — an empty pack certifies nothing');
  const seen = new Set();
  for (const r of doc.requirements) {
    if (typeof r !== 'object' || r === null) bad('each requirement must be an object');
    for (const k of Object.keys(r))
      if (!REQ_KEYS.includes(k)) bad(`requirement: unknown key "${k}"`);
    for (const k of ['id', 'theme', 'evidence'])
      if (!nonEmptyString(r[k])) bad(`requirement ${r.id ?? '?'}: ${k} must be a non-empty string`);
    if (!stringArray(r.gaps)) bad(`requirement ${r.id}: gaps must be an array of strings`);
    if (seen.has(r.id)) bad(`duplicate requirement id "${r.id}"`);
    seen.add(r.id);
    if (!Array.isArray(r.cases) || r.cases.length === 0)
      bad(
        `requirement ${r.id}: cases must be non-empty — a requirement with no evidence is unprovable`,
      );
    if (new Set(r.cases).size !== r.cases.length) bad(`requirement ${r.id}: duplicate case ids`);
    for (const c of r.cases) {
      const def = knownCases.get(c);
      if (!def) bad(`requirement ${r.id}: unknown case "${c}"`);
      // Review C-2: packs carry agent evidence, which a real run must be able
      // to produce — and the real-run gate admits execution_mode "model" only
      // (an allowlist, so an unknown or misspelled mode is refused too).
      if (def.execution_mode !== 'model')
        bad(
          `requirement ${r.id}: ${c} has execution_mode "${def.execution_mode}" — only "model" cases can produce real evidence`,
        );
    }
  }
  return doc;
}

const packFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile())
    .sort();

const parsePack = (dir, file) => {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    throw new PackError('PACK_INVALID', `${file}: not valid JSON (${e.message.slice(0, 60)})`);
  }
};

/** Validate every pack; reports ALL broken packs, not just the first. */
export function loadAllPacks(knownCases, dir = PACKS_DIR) {
  const packs = [];
  const errors = [];
  for (const f of packFiles(dir)) {
    try {
      packs.push(validatePack(parsePack(dir, f), f, knownCases));
    } catch (e) {
      errors.push(e.message.replace(/^PACK_INVALID: /, ''));
    }
  }
  if (errors.length > 0) throw new PackError('PACK_INVALID', errors.join(' | '));
  return packs;
}

/** Load one pack by id; unknown ids refuse, never select nothing. */
export function loadPack(id, knownCases, dir = PACKS_DIR) {
  const available = packFiles(dir).map((f) => f.slice(0, -5));
  if (!nonEmptyString(id) || !available.includes(id))
    throw new PackError(
      'PACK_UNKNOWN',
      `no such pack "${id}" — available: ${available.join(', ')}`,
    );
  return validatePack(parsePack(dir, `${id}.json`), `${id}.json`, knownCases);
}

/** The distinct, sorted case ids a pack needs. */
export const packCaseIds = (pack) => [...new Set(pack.requirements.flatMap((r) => r.cases))].sort();

const MEANING = {
  REAL: 'REAL run: COVERED means every backing case ran through the executor recorded in `model` (model id as requested; the binary is recorded, not verified) and passed',
  FAKE: 'FAKE run: proves the harness chain only — says nothing about any model or agent (no requirement can read COVERED)',
  UNKNOWN:
    'executor mode not stated: nothing about any model or agent can be read from this report (no requirement can read COVERED)',
  REAL_MODIFIED:
    'REAL run on a harness tree that differed from harness_commit, or could not be compared: the scorer that judged it is not provably the one at that commit (no requirement can read COVERED; passing ones read HARNESS_MODIFIED)',
};

/**
 * Per-requirement verdicts. `run` carries the provenance that must travel
 * with the report: executorMode (FAKE|REAL), runId, harnessCommit,
 * harnessDirty, model ({provider, model_id, executor_binary,
 * binary_overridden} for REAL runs), and stopped (the batch halted early,
 * or null).
 */
export function packReport(pack, entries, run) {
  const verdictOf = new Map();
  for (const e of entries) {
    const id = e.caseDef?.id ?? e.result?.case_id;
    const v = e.result?.verdict ?? 'NO_VERDICT';
    // duplicates: any non-PASS outcome for a case wins, in either order
    if (!verdictOf.has(id) || v !== 'PASS') verdictOf.set(id, v);
  }
  const real = run?.executorMode === 'REAL';
  const mode = real ? 'REAL' : run?.executorMode === 'FAKE' ? 'FAKE' : 'UNKNOWN';
  // only a tree PROVEN to match the commit can back COVERED (F-65)
  const clean = run?.harnessDirty === false;
  const statusOf = (allPass) => {
    if (!real) return 'HARNESS_ONLY';
    if (!allPass) return 'NOT_COVERED';
    return clean ? 'COVERED' : 'HARNESS_MODIFIED';
  };
  const requirements = pack.requirements.map((r) => {
    const cases = r.cases.map((c) => ({ case: c, verdict: verdictOf.get(c) ?? 'NOT_RUN' }));
    const allPass = cases.every((x) => x.verdict === 'PASS');
    return {
      id: r.id,
      theme: r.theme,
      status: statusOf(allPass),
      cases,
      gaps: r.gaps,
    };
  });
  return {
    pack: pack.id,
    title: pack.title,
    regulator: pack.regulator,
    clause_status: pack.clause_status,
    executor_mode: mode,
    meaning: MEANING[real && !clean ? 'REAL_MODIFIED' : mode],
    model: real ? (run?.model ?? null) : null,
    run_id: run?.runId ?? null,
    harness_commit: run?.harnessCommit ?? null,
    harness_dirty: run?.harnessDirty ?? null,
    batch_stopped: run?.stopped ?? null,
    covered: requirements.filter((r) => r.status === 'COVERED').length,
    total: requirements.length,
    not_covered: pack.not_covered,
    not_covered_is_exhaustive: false,
    requirements,
  };
}
