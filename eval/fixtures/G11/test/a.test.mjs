import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greetA } from '../lib/a.mjs';
test('a', () => assert.equal(greetA(), 'hello'));
