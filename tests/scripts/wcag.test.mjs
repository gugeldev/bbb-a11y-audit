import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CRITERIA,
  criteriaFilter,
  enClause,
  matchesTopic,
  overlaps,
  topicKey,
} from '../../bbb-a11y-audit/scripts/lib/wcag.mjs';

describe('wcag', () => {
  it('lists the 55 WCAG 2.2 A and AA criteria, without 4.1.1 (removed in 2.2)', () => {
    assert.equal(CRITERIA.length, 55);
    assert.equal(new Set(CRITERIA).size, 55);
    assert.ok(!CRITERIA.includes('4.1.1'));
    assert.ok(CRITERIA.includes('2.4.11') && CRITERIA.includes('3.3.8'));
  });

  it('maps criteria to EN 301 549 clause 9', () => {
    assert.equal(enClause('1.4.3'), '9.1.4.3');
    assert.equal(enClause('9.7', 'EN'), '9.7');
  });

  it('matches topics in both directions, never by plain prefix', () => {
    assert.ok(overlaps('2.4', '2.4.7'));
    assert.ok(overlaps('2.4.7', '2'));
    assert.ok(!overlaps('2.4.1', '2.4.11'));
    assert.ok(matchesTopic('1.4.3', []));
    assert.ok(matchesTopic('1.4.3', ['2.1', '1.4']));
    assert.ok(!matchesTopic('1.4.3', ['2.1']));
  });

  it('filters criteria by meta.criteria and meta.guidelines', () => {
    const all = criteriaFilter({});
    const guideline = criteriaFilter({ guidelines: ['4.1'] });
    const criterion = criteriaFilter({ criteria: ['2.4.7'] });
    assert.ok(all('1.1.1'));
    assert.deepEqual(CRITERIA.filter(guideline), ['4.1.2', '4.1.3']);
    assert.deepEqual(CRITERIA.filter(criterion), ['2.4.7']);
  });

  it('gives runs that cover the same criteria the same key, however the topic was asked', () => {
    assert.equal(topicKey({ guidelines: ['2.4', '2.1'] }), topicKey({ guidelines: ['2.1', '2.4'] }));
    assert.equal(topicKey({ guidelines: ['4'] }), topicKey({ guidelines: ['4.1'] }));
    assert.equal(topicKey({ criteria: ['4.1.3', '4.1.2'] }), topicKey({ guidelines: ['4.1'] }));
    assert.equal(topicKey({ criteria: ['2.4.7'] }), '2.4.7');
    assert.notEqual(topicKey({ guidelines: ['2.4'] }), topicKey({ guidelines: ['2.1'] }));
    assert.equal(topicKey(undefined), 'full');
    assert.equal(topicKey({ guidelines: ['1', '2', '3', '4'] }), 'full');
  });
});
