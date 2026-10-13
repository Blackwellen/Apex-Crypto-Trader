import { describe, expect, it } from 'vitest';
import { canEnableOnBucket, cloneToWizard, emptyWizard, firstInvalidStep, nextStage, promotionBlocker, slugify, toCommand, validateStep } from './strategy';

describe('stage rules', () => {
  it('advances one step at a time and never reaches live', () => {
    expect(nextStage('research')).toBe('paper'); expect(nextStage('paper')).toBe('live_candidate'); expect(nextStage('live_candidate')).toBeNull();
  });
  it('live_candidate needs evidence; the last stage reports the live lock', () => {
    expect(promotionBlocker('research', false)).toBeNull();
    expect(promotionBlocker('paper', false)).toMatch(/evidence/);
    expect(promotionBlocker('paper', true)).toBeNull();
    expect(promotionBlocker('live_candidate', true)).toMatch(/Live is locked/);
  });
  it('research strategies cannot be enabled on buckets', () => {
    expect(canEnableOnBucket('research')).toBe(false); expect(canEnableOnBucket('paper')).toBe(true);
  });
});
describe('wizard validation', () => {
  const valid = () => ({ ...emptyWizard(), name: 'My trend', slug: 'my_trend', families: ['cex'] });
  it('requires name, slug and a family', () => {
    expect(Object.keys(validateStep(0, emptyWizard())).sort()).toEqual(['families', 'name', 'slug']);
    expect(validateStep(0, valid())).toEqual({});
  });
  it('parameter bounds need min <= default <= max and unique names', () => {
    const w = { ...valid(), bounds: [{ name: 'lookback', min: '10', max: '100', def: '500' }, { name: 'lookback', min: '1', max: '2', def: '1' }, { name: 'Bad Name', min: '1', max: '2', def: '1' }] };
    const e = validateStep(2, w); expect(e['b0.def']).toMatch(/min <= default/); expect(e['b1.name']).toMatch(/Duplicate/); expect(e['b2.name']).toBeDefined();
    expect(validateStep(2, { ...valid(), bounds: [{ name: 'lookback', min: '10', max: '100', def: '50' }] })).toEqual({});
  });
  it('risk budget and validation plan are whole numbers in range', () => {
    expect(validateStep(3, { ...valid(), maxOrderBps: '20000' }).maxOrderBps).toBeDefined();
    expect(validateStep(3, { ...valid(), maxDailyLossBps: '1.5' }).maxDailyLossBps).toBeDefined();
    expect(validateStep(4, { ...valid(), paperDays: '0' }).paperDays).toBeDefined();
    expect(firstInvalidStep(valid())).toBe(-1); expect(firstInvalidStep(emptyWizard())).toBe(0);
  });
  it('slugify yields a valid slug', () => { expect(slugify('  My Trend! v2 ')).toBe('my_trend_v2'); expect(slugify('123 abc')).toBe('abc'); });
  it('command never carries evidence or an environment, and clones copy bounds', () => {
    const w = cloneToWizard({ key: 'cex_trend_momentum', name: 'Trend', category: 'cex_directional', summary: 's', allowed_families: ['cex'], data_sources: ['ohlcv'], regimes: ['trending'],
      param_bounds: { lookback_bars: { min: 10, max: 200, default: 50 } }, risk_budget: { max_order_bps_of_budget: 2500 } });
    expect(w.clonedFrom).toBe('cex_trend_momentum'); expect(validateStep(0, w)).toEqual({}); expect(validateStep(2, w)).toEqual({});
    const c = toCommand(w, 'ws-1') as Record<string, unknown>;
    expect(c.paramBounds).toEqual({ lookback_bars: { min: 10, max: 200, default: 50 } }); expect(c).not.toHaveProperty('evidence'); expect(c).not.toHaveProperty('stage'); expect(c).not.toHaveProperty('environment');
  });
});
