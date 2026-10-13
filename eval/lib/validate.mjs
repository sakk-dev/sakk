import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 最小 JSON-Schema 子集校验器（Gold Eval M1A · 零新依赖纪律）。
 *
 * 只实现本目录三份 schema 实际用到的子集：required / type / enum / pattern /
 * minLength / minItems / minimum / exclusiveMinimum / items(type|object required)。
 * schema 文件本身是标准 draft-07 文档——将来若引入 ajv 可直接换引擎；
 * 在那之前，宁可少实现也不装实现：不支持的关键字一律忽略并在此注明。
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
    errors.push(`${path}: 期望 ${JSON.stringify(schema.type)},实际 ${typeOf(doc)}`);
  if (schema.enum !== undefined && !schema.enum.includes(doc))
    errors.push(`${path}: 不在枚举 ${JSON.stringify(schema.enum)}`);
  if (typeOf(doc) === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(doc))
      errors.push(`${path}: 不匹配 pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && doc.length < schema.minLength)
      errors.push(`${path}: 长度 < ${schema.minLength}`);
  }
  if (typeOf(doc) === 'number') {
    if (schema.minimum !== undefined && doc < schema.minimum) errors.push(`${path}: < minimum`);
    if (schema.exclusiveMinimum !== undefined && doc <= schema.exclusiveMinimum)
      errors.push(`${path}: <= exclusiveMinimum`);
  }
  if (typeOf(doc) === 'array') {
    if (schema.minItems !== undefined && doc.length < schema.minItems)
      errors.push(`${path}: 项数 < ${schema.minItems}`);
    if (schema.items !== undefined)
      doc.forEach((it, i) => errors.push(...validate(it, schema.items, `${path}[${i}]`)));
  }
  if (typeOf(doc) === 'object') {
    for (const req of schema.required ?? [])
      if (!(req in doc)) errors.push(`${path}: 缺必填字段 ${req}`);
    for (const [k, sub] of Object.entries(schema.properties ?? {}))
      if (k in doc) errors.push(...validate(doc[k], sub, `${path}.${k}`));
  }
  return errors;
}

export function validateAgainst(doc, schemaName) {
  const errors = validate(doc, loadSchema(schemaName));
  return { ok: errors.length === 0, errors };
}
