import { describe, expect, it } from 'vitest';
import { ALL_CAPABILITIES, TRADE_CAPS, chainCoverage, effectiveStatus, readiness, type CapMap } from './chains';

const certified = (names: readonly string[]): CapMap => Object.fromEntries(names.map((n) => [n, { status: 'CERTIFIED' as const, evidence: `evidence/${n}.log` }]));

describe('readiness derivation (never ready without CERTIFIED)', () => {
  it('no capability data => nothing is ready', () => {
    for (const v of [undefined, null, {}]) { const r = readiness(v); expect(r.research).toBe('none'); expect(r.trading).toBe('not_ready'); expect(r.counts.UNRECORDED).toBe(ALL_CAPABILITIES.length); }
  });
  it('all PENDING / UNSUPPORTED => not ready', () => {
    const caps = Object.fromEntries(ALL_CAPABILITIES.map((c, i) => [c, { status: i % 2 ? 'PENDING' : 'UNSUPPORTED' }])) as CapMap;
    expect(readiness(caps).trading).toBe('not_ready'); expect(readiness(caps).research).toBe('none');
  });
  it('READ_ONLY gives research but NEVER trading, even for swap/submit', () => {
    const caps: CapMap = { getBalances: { status: 'READ_ONLY' }, swap: { status: 'READ_ONLY' }, submit: { status: 'READ_ONLY' } };
    const r = readiness(caps); expect(r.research).toBe('read_only_available'); expect(r.trading).toBe('not_ready');
  });
  it('swap + submit CERTIFIED alone is only partial', () => {
    const r = readiness(certified(['swap', 'submit'])); expect(r.trading).toBe('partial'); expect(r.missingForTrading).toContain('simulate');
  });
  it('missing either swap or submit blocks trading readiness', () => {
    for (const drop of ['swap', 'submit']) {
      const r = readiness(certified(TRADE_CAPS.filter((c) => c !== drop))); expect(r.trading).toBe('partial'); expect(r.missingForTrading).toEqual([drop]);
    }
  });
  it('trading is certified only when every required capability is CERTIFIED with evidence', () => {
    expect(readiness(certified(TRADE_CAPS)).trading).toBe('certified');
  });
  it('CERTIFIED without an evidence ref is not trusted', () => {
    const caps = certified(TRADE_CAPS); caps.submit = { status: 'CERTIFIED', evidence: '  ' };
    expect(effectiveStatus(caps.submit)).toBe('PENDING');
    const r = readiness(caps); expect(r.trading).toBe('partial'); expect(r.certifiedWithoutEvidence).toEqual(['submit']);
  });
  it('unknown capability names are ignored, never counted', () => {
    expect(readiness({ madeUp: { status: 'CERTIFIED', evidence: 'x' } }).trading).toBe('not_ready');
  });
});
describe('chainCoverage', () => {
  it('counts only certified-trading chains', () => {
    const chains = [{ id: 'a', family: 'evm', capabilities: certified(TRADE_CAPS) }, { id: 'b', family: 'evm', capabilities: { getBalances: { status: 'READ_ONLY' as const } } }, { id: 'c', family: 'svm' }];
    expect(chainCoverage(['evm'], chains)).toEqual({ chains: 2, tradingCertified: 1, researchReadable: 2, venues: false });
    expect(chainCoverage(['cex'], chains)).toEqual({ chains: 0, tradingCertified: 0, researchReadable: 0, venues: true });
  });
});
