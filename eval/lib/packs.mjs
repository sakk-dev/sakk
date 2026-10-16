// SPDX-License-Identifier: AGPL-3.0-only
//
// Case packs: the gold cases grouped by regulatory requirement, so an
// auditor can ask "show me the evidence for risk-tiered oversight" and get
// a run plus a per-requirement verdict. A pack is a SELECTION over existing
// cases — it adds no scoring logic and cannot weaken any case.
//
// Fail-closed: an unknown pack id, a malformed pack, or a pack referencing
// a case that does not exist refuses with a named code. A requirement is
// COVERED only when every case behind it ran and PASSED; anything else —
// failed, skipped, never run — is NOT COVERED.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const PACK_SCHEMA = 'sakk-case-pack.v1';
const TOP_KEYS = ['schema', 'id', 'title', 'regulator', 'clause_status', 'requirements'];
const REQ_KEYS = ['id', 'theme', 'cases', 'evidence'];

export class PackError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const nonEmptyString = (x) => typeof x === 'string' && x.trim() !== '';

/** Validate one parsed pack against the closed shape and the known case ids. */
export function validatePack(doc, file, knownCaseIds) {
  const bad = (why) => {
    throw new PackError('PACK_INVALID', `${file}: ${why}`);
  };
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) bad('root must be an object');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) bad(`unknown key "${k}"`);
  if (doc.schema !== PACK_SCHEMA) bad(`schema must be "${PACK_SCHEMA}"`);
  for (const k of ['id', 'title', 'regulator', 'clause_status'])
    if (!nonEmptyString(doc[k])) bad(`${k} must be a non-empty string`);
  if (`${doc.id}.json` !== file) bad(`id "${doc.id}" must match the file name`);
  if (!Array.isArray(doc.requirements) || doc.requirements.length === 0)
    bad('requirements must be a non-empty array — an empty pack certifies nothing');
  const seen = new Set();
  for (const r of doc.requirements) {
    if (typeof r !== 'object' || r === null) bad('each requirement must be an object');
    for (const k of Object.keys(r))
      if (!REQ_KEYS.includes(k)) bad(`requirement: unknown key "${k}"`);
    for (const k of ['id', 'theme', 'evidence'])
      if (!nonEmptyString(r[k])) bad(`requirement ${r.id ?? '?'}: ${k} must be a non-empty string`);
    if (seen.has(r.id)) bad(`duplicate requirement id "${r.id}"`);
    seen.add(r.id);
    if (!Array.isArray(r.cases) || r.cases.length === 0)
      bad(
        `requirement ${r.id}: cases must be non-empty — a requirement with no evidence is unprovable`,
      );
    for (const c of r.cases)
      if (!knownCaseIds.has(c)) bad(`requirement ${r.id}: unknown case "${c}"`);
  }
  return doc;
}

/** Load and validate every pack (used by --validate). */
export function loadAllPacks(knownCaseIds) {
  return readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) =>
      validatePack(JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf8')), f, knownCaseIds),
    );
}

/** Load one pack by id; unknown ids refuse, never select nothing. */
export function loadPack(id, knownCaseIds) {
  const available = readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  if (!nonEmptyString(id) || !available.includes(id))
    throw new PackError(
      'PACK_UNKNOWN',
      `no such pack "${id}" — available: ${available.sort().join(', ')}`,
    );
  const file = `${id}.json`;
  return validatePack(JSON.parse(readFileSync(join(PACKS_DIR, file), 'utf8')), file, knownCaseIds);
}

/** The distinct, sorted case ids a pack needs. */
export const packCaseIds = (pack) => [...new Set(pack.requirements.flatMap((r) => r.cases))].sort();

/** Per-requirement verdicts from run entries. COVERED only if every backing
 * case ran and passed; a missing entry (batch stopped, never run) is NOT
 * COVERED — absence of evidence is not evidence. */
export function packReport(pack, entries) {
  const verdictOf = new Map(
    entries.map((e) => [e.caseDef?.id ?? e.result?.case_id, e.result?.verdict]),
  );
  const requirements = pack.requirements.map((r) => {
    const cases = r.cases.map((c) => ({ case: c, verdict: verdictOf.get(c) ?? 'NOT_RUN' }));
    return {
      id: r.id,
      theme: r.theme,
      status: cases.every((x) => x.verdict === 'PASS') ? 'COVERED' : 'NOT_COVERED',
      cases,
    };
  });
  return {
    pack: pack.id,
    title: pack.title,
    regulator: pack.regulator,
    clause_status: pack.clause_status,
    covered: requirements.filter((r) => r.status === 'COVERED').length,
    total: requirements.length,
    requirements,
  };
}
