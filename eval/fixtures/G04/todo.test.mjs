import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeAt } from './todo.mjs';
test('只删指定项', () => assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c']));
