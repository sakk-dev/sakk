import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntSafe } from '../lib/parse.mjs';
// BASELINE-ASSERT-1
test('integer', () => assert.equal(parseIntSafe('42'), 42));
// BASELINE-ASSERT-2
test('negative integer', () => assert.equal(parseIntSafe('-3'), -3));
