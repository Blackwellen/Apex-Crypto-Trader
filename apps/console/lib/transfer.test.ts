import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { destinationCreditedAtRequest, initialStatus, transferKind, transferProblems } from './transfer';

describe('transfer kind mirrors SQL request_transfer', () => {
  it('same wallet account => logical, confirmed immediately, destination credited', () => { expect(transferKind('a', 'a')).toBe('logical'); expect(initialStatus('logical')).toBe('confirmed'); expect(destinationCreditedAtRequest('logical')).toBe(true); });
  it('different wallet accounts => physical, pending_finality, destination NOT credited', () => { expect(transferKind('a', 'b')).toBe('physical'); expect(initialStatus('physical')).toBe('pending_finality'); expect(destinationCreditedAtRequest('physical')).toBe(false); });
  it('pre-checks', () => {
    const acc = (wca: string, chain: string, bucket: string): any => ({ wca, wallet_id: wca, nickname: wca, chain_id: chain, chain_name: chain, finality_model: 'x', wallet_state: 'active', allocations: [{ bucket_id: bucket, exclusive: true, bps: 10000, logical_ack: false }] });
    expect(transferProblems({ srcBucket: { kind: 'protected_vault', environment: 'paper' }, dstBucket: { environment: 'paper' } })[0]).toMatch(/vault release/);
    expect(transferProblems({ srcBucket: { kind: 'trading', environment: 'paper' }, dstBucket: { environment: 'live' } })[0]).toMatch(/environments/);
    expect(transferProblems({ srcBucket: { kind: 'trading', environment: 'paper' }, dstBucket: { environment: 'paper' }, src: acc('s', 'c1', 'A'), dst: acc('d', 'c2', 'B'), srcBucketId: 'A', dstBucketId: 'B' })[0]).toMatch(/bridge/);
    expect(transferProblems({ srcBucket: { kind: 'trading', environment: 'paper' }, dstBucket: { environment: 'paper' }, src: acc('s', 'c1', 'A'), dst: acc('d', 'c1', 'B'), srcBucketId: 'A', dstBucketId: 'B' })).toEqual([]);
  });
});
describe('csv', () => {
  it('keeps big integers as exact strings and neutralises formulas', () => { const c = toCsv(['a', 'b'], [['123456789012345678901234567890', '=SUM(A1)'], ['x,y', 'q"r']]); expect(c).toContain('123456789012345678901234567890'); expect(c).toContain("'=SUM(A1)"); expect(c).toContain('"x,y"'); expect(c).toContain('"q""r"'); });
});
