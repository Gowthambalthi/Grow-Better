'use strict';

/**
 * Provenance guards for the institutional ranking tables.
 *
 * These read the real data/institutional.db but are strictly READ-ONLY: nothing here writes. The point
 * is that the ranking endpoints must never be able to present an unmeasurable score as a measurement,
 * and that recomputing can never silently flatten a column.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../common/institutional/institutionalService');

const PROV = S.getInstitutionalDataProvenance({ force: true });

test('provenance: the rule is enforced — "measured" requires rows, variation, and reproducibility', () => {
  for (const [table, info] of Object.entries(PROV.tables)) {
    if (info.rows === 0) { assert.equal(info.measured, false, `${table}: an empty table cannot be measured`); continue; }
    if (info.measured) {
      const distinct = Object.values(info.componentDiversity || {});
      assert.ok(distinct.every(n => n > 1), `${table}: claims to be measured but a component column is constant`);
      assert.ok(info.reproducibleFromOwnComponents >= 0.95,
        `${table}: claims to be measured but only ${info.reproducibleFromOwnComponents} of rows reproduce from their own components`);
    } else {
      assert.ok(typeof info.reason === 'string' && info.reason.length > 10, `${table}: an unmeasured table must say why`);
    }
  }
});

test('provenance: a constant component column forces the table to be unmeasured', () => {
  // The live institute table has all four components constant, so this is the branch that fires today.
  const inst = PROV.tables.institute_growth_score;
  if (inst.rows > 0 && Object.values(inst.componentDiversity).some(n => n === 1)) {
    assert.equal(inst.measured, false);
    assert.ok(Object.values(inst.componentDiversity).every(n => n === 1) ? inst.distinctScoresIfRecomputed === 1 : true);
  }
});

test('provenance: it names the tables no code writes, and the real data path', () => {
  assert.ok(Array.isArray(PROV.writers.noneFoundFor));
  assert.ok(PROV.writers.noneFoundFor.includes('institute_growth_score'));
  assert.ok(PROV.writers.noneFoundFor.includes('scheme_growth_score'));
  const writers = PROV.writers.inThisCodebase.join(' ');
  assert.ok(writers.includes('amfiOfficialSync.js'), 'the real MF holdings path must be named');
  assert.ok(writers.includes('generateLargeDataset.js'), 'the synthetic generator must be flagged as synthetic');
});

test('provenance: the summary note refuses to call the scores a measurement', () => {
  assert.equal(PROV.measured, false, 'with generated inputs this must not claim to be measured');
  assert.ok(/placeholder|not a measurement|NOT a measurement/i.test(PROV.note));
});

test('provenance: empty source tables are reported, not glossed over', () => {
  assert.ok(Array.isArray(PROV.emptySourceTables));
  // symbol_master and holdings_monthly are the real feed's own tables; if they are empty then no real
  // holdings data can have reached these scores.
  for (const t of PROV.emptySourceTables) assert.ok(typeof t === 'string' && t.length > 0);
});

test('recompute: a dry run never writes, and reports a degenerate outcome before anyone commits it', () => {
  const res = S.recomputeGrowthScoreTables({ dryRun: true });
  assert.equal(res.dryRun, true);
  for (const [table, info] of Object.entries(res.tables)) {
    if (info.rows === 0) continue;
    assert.equal(info.updated, 0, `${table}: a dry run must not report updates`);
    assert.ok(info.wouldChange <= info.rows, `${table}: cannot change more rows than exist`);
    assert.equal(typeof info.distinctBefore, 'number');
    assert.equal(typeof info.distinctAfter, 'number');
    if (info.distinctAfter === 1) {
      assert.equal(info.degenerate, true, `${table}: collapsing to one value must be flagged`);
      assert.ok(/flatten|no information/i.test(info.warning));
    }
  }
});

test('recompute: it writes only the score column, so the components stay reversible', () => {
  // Guard the contract by reading the SQL it would use: components must never appear in an UPDATE.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'common', 'institutional', 'institutionalService.js'), 'utf8');
  const m = /UPDATE ' \+ table \+ ' SET ([^']+)'/.exec(src);
  assert.ok(m, 'the recompute UPDATE must be findable');
  const setClause = m[1].replace(/\s*WHERE\s*$/, '').trim();
  assert.equal(setClause, 'growth_score = @growth_score', 'only growth_score may be written');
  for (const col of ['aum_growth_pct', 'deployment_ratio', 'new_position_count', 'exit_ratio']) {
    assert.ok(!setClause.includes(col), `${col} is an INPUT and must never be overwritten by a recompute`);
  }
});
