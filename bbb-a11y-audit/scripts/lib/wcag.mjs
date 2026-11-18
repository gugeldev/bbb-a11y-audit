/**
 * WCAG 2.2 level A and AA: the 55 success criteria this skill audits, and how a run's topic
 * (`meta.guidelines` / `meta.criteria`) selects among them.
 */

export const CRITERIA = Object.freeze([
  ...['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5'],
  ...['1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13'],
  ...['2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2', '2.3.1'],
  ...['2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.11'],
  ...['2.5.1', '2.5.2', '2.5.3', '2.5.4', '2.5.7', '2.5.8'],
  ...['3.1.1', '3.1.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6'],
  ...['3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.7', '3.3.8'],
  ...['4.1.2', '4.1.3'],
]);

export const isWcagCriterion = (criterion) => CRITERIA.includes(criterion);

/** EN 301 549 clause 9 mirrors WCAG: 1.4.3 is clause 9.1.4.3. EN-only clauses are given as is. */
export const enClause = (criterion, standard) => (standard === 'EN' ? criterion : `9.${criterion}`);

/**
 * True when two references overlap: they are equal, or one is a principle or guideline that
 * contains the other ("2.4" overlaps "2.4.7", and "2.4.7" overlaps "2.4").
 */
export const overlaps = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** True when `topic` is empty (no topic: everything is in scope) or overlaps `ref`. */
export const matchesTopic = (ref, topic) => !topic.length || topic.some((t) => overlaps(ref, t));

/**
 * The criteria filter of a run: `meta.criteria` lists exact criteria, `meta.guidelines` lists
 * guidelines or principles. Both absent means the whole standard.
 */
export function criteriaFilter({ criteria, guidelines } = {}) {
  return (criterion) =>
    (!criteria || criteria.includes(criterion)) &&
    (!guidelines || guidelines.some((g) => criterion.startsWith(`${g}.`)));
}

/**
 * Key that identifies a run's topic by the criteria it covers, so runs are compared only with
 * runs of the same topic however it was asked: "principio 4" and "diretriz 4.1" both cover 4.1.2
 * and 4.1.3. A topic that covers every criterion is "full".
 */
export function topicKey(meta) {
  const covered = CRITERIA.filter(criteriaFilter(meta || {}));
  return covered.length === CRITERIA.length ? 'full' : covered.join(',');
}
