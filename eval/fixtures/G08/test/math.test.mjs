import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo, product } from '../lib/math.mjs';
test('sumTo', () => assert.equal(sumTo(4), 10));
test('product', () => assert.equal(product([2, 3]), 6));
