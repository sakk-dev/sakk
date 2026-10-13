import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from '../lib/calc.mjs';
test('sumTo(3)=6', () => assert.equal(sumTo(3), 6));
test('sumTo(1)=1', () => assert.equal(sumTo(1), 1));
