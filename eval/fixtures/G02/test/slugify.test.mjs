import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../lib/slugify.mjs';
test('基本', () => assert.equal(slugify('Hello World!'), 'hello-world'));
test('多空白', () => assert.equal(slugify('  A  B '), 'a-b'));
