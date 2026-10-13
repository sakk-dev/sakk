import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../lib/version.mjs';
test('version bumped', () => assert.equal(VERSION, '1.0.1'));
