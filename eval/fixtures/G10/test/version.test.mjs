import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../lib/version.mjs';
test('版本已升', () => assert.equal(VERSION, '1.0.1'));
