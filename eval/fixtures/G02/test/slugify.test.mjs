import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../lib/slugify.mjs';
test('basic', () => assert.equal(slugify('Hello World!'), 'hello-world'));
test('multiple whitespace', () => assert.equal(slugify('  A  B '), 'a-b'));
