import { describe, expect, it } from 'vitest';
import { fillRatioBps, gasCell, isCancellable, pctFromBps, slipCell, stateNote, timeline } from './orders';

describe('order pipeline', () => {
  it('marks only states with a recorded event as reached', () => {
    const t = timeline([{ to: 'CANDIDATE', at: 't1' }, { to: 'RISK_EVALUATING', at: 't2' }], 'RISK_EVALUATING');
    const reached = t.filter((s) => s.reached).map((s) => s.state); expect(reached).toEqual(['SIGNAL', 'CANDIDATE', 'RISK_EVALUATING']);
    expect(t.find((s) => s.current)?.state).toBe('RISK_EVALUATING'); expect(t.find((s) => s.state === 'ADMITTED')?.reached).toBe(false);
  });
  it('UNKNOWN is flagged as awaiting reconciliation and never retried', () => {
    expect(stateNote({ state: 'UNKNOWN' })?.text).toMatch(/never be blindly retried/); expect(stateNote({ state: 'UNKNOWN' })?.tone).toBe('warn');
  });
  it('RISK_EVALUATING without a decision says it is waiting for the risk service', () => {
    expect(stateNote({ state: 'RISK_EVALUATING', risk_decision: null })?.text).toMatch(/Waiting for the risk service/);
    expect(stateNote({ state: 'RISK_EVALUATING', risk_decision: 'ADMIT' })).toBeNull();
  });
  it('only pre-submission states are cancellable', () => {
    for (const s of ['RISK_EVALUATING', 'ADMITTED', 'PREPARED', 'APPROVAL_WAIT']) expect(isCancellable(s)).toBe(true);
    for (const s of ['SUBMITTING', 'UNKNOWN', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED']) expect(isCancellable(s)).toBe(false);
  });
  it('fill ratio is exact integer math; unrecorded values render as an em dash', () => {
    expect(fillRatioBps('1', '3')).toBe(3333); expect(pctFromBps(3333)).toBe('33.33%'); expect(fillRatioBps('0', '0')).toBeNull(); expect(pctFromBps(null)).toBe('—');
    expect(fillRatioBps('123456789012345678901234567890', '246913578024691357802469135780')).toBe(5000);
    expect(slipCell(null, null)).toBe('—'); expect(slipCell(5, null)).toBe('5.0 / — bps'); expect(gasCell(null, 18, 'ETH')).toBe('—'); expect(gasCell('1500000000000000', 18, 'ETH')).toBe('0.0015 ETH');
  });
});
