import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeAt } from './todo.mjs';
test('removes only the targeted item', () =>
  assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c']));
