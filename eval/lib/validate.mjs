import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal JSON-Schema subset validator (zero-new-dependencies discipline).
 *
 * Implements only the subset the schemas in this directory actually use:
 * required / type / enum / pattern / minLength / minItems / minimum /
 * exclusiveMinimum / items (type | object required). The schema files
 * themselves are standard draft-07 documents — if ajv is ever adopted the
 * engine swaps in directly. Until then: better to under-implement than to
 * pretend — unsupported keywords are ignored, as noted here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(HERE, '..', 'schemas', name), 'utf8'));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // object/string/number/boolean
}

function typeOk(v, t) {
  const ts = Array.isArray(t) ? t : [t];
  return ts.some((x) =>
    x === 'integer' ? typeOf(v) === 'number' && Number.isInteger(v) : typeOf(v) === x,
  );
}

export function validate(doc, schema, path = '$') {
  const errors = [];
  if (schema.type !== undefined && !typeOk(doc, schema.type))
    errors.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${typeOf(doc)}`);
  if (schema.enum !== undefined && !schema.enum.includes(doc))
    errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}`);
  if (typeOf(doc) === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(doc))
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && doc.length < schema.minLength)
      errors.push(`${path}: length < ${schema.minLength}`);
  }
  if (typeOf(doc) === 'number') {
    if (schema.minimum !== undefined && doc < schema.minimum) errors.push(`${path}: < minimum`);
    if (schema.exclusiveMinimum !== undefined && doc <= schema.exclusiveMinimum)
      errors.push(`${path}: <= exclusiveMinimum`);
  }
  if (typeOf(doc) === 'array') {
    if (schema.minItems !== undefined && doc.length < schema.minItems)
      errors.push(`${path}: item count < ${schema.minItems}`);
    if (schema.items !== undefined)
      doc.forEach((it, i) => errors.push(...validate(it, schema.items, `${path}[${i}]`)));
  }
  if (typeOf(doc) === 'object') {
    for (const req of schema.required ?? [])
      if (!(req in doc)) errors.push(`${path}: missing required field ${req}`);
    for (const [k, sub] of Object.entries(schema.properties ?? {}))
      if (k in doc) errors.push(...validate(doc[k], sub, `${path}.${k}`));
  }
  return errors;
}

export function validateAgainst(doc, schemaName) {
  const errors = validate(doc, loadSchema(schemaName));
  return { ok: errors.length === 0, errors };
}
