import { describe, expect, it } from 'vitest';
import { base58Decode, bech32Check, FAMILIES, secretHint, validateAddress } from './address';
import { basketOverlaps, chainConcentration, parsePct, rebalancePreview, weightSummary } from './basket';
import { waterfallPreview, waterfallTotalBps } from './waterfall';
import { buildPolicy, diffPolicy, policyToFields } from './policy';
import { formatUnits, parseUnits } from '../format';

const SEED12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
describe('address validators', () => {
  it('accepts well-formed addresses per family', () => {
    expect(validateAddress('evm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362')).toMatchObject({ ok: true, normalized: '0x9a4fc2bc7897dd21305b92c0e5cb86dffc984362' });
    expect(validateAddress('evm', '0x' + 'ab'.repeat(20))).toMatchObject({ ok: true, warnings: [] });
    expect(validateAddress('svm', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin').ok).toBe(true);
    expect(validateAddress('sui', '0x' + 'ab12'.repeat(16)).ok).toBe(true);
    expect(validateAddress('aptos', '0x1').ok).toBe(true);
    expect(validateAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').ok).toBe(true);
    expect(validateAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').ok).toBe(true);
    expect(validateAddress('bitcoin', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').ok).toBe(true);
    expect(validateAddress('cosmos', 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02').ok).toBe(true);
    expect(validateAddress('ton', 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2').ok).toBe(true);
    expect(validateAddress('near', 'a'.repeat(64)).ok).toBe(true);
    expect(validateAddress('near', 'treasury-account.team.near').ok).toBe(true);
    expect(validateAddress('cex', 'exchange-main-subaccount-01').ok).toBe(true);
  });
  it('rejects structurally invalid addresses', () => {
    expect(validateAddress('evm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc98436').ok).toBe(false);
    expect(validateAddress('evm', '9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362').ok).toBe(false);
    expect(validateAddress('evm', '0xZZ4Fc2bC7897dd21305B92C0e5cb86DFFc984362').ok).toBe(false);
    expect(validateAddress('svm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362').ok).toBe(false);
    expect(validateAddress('svm', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9Pu').ok).toBe(false);
    expect(validateAddress('sui', '0x1234').ok).toBe(false);
    expect(validateAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6').ok).toBe(false);
    expect(validateAddress('tron', 'XR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').ok).toBe(false);
    expect(validateAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx').ok).toBe(false);    // bad bech32 checksum
    expect(validateAddress('bitcoin', 'BC1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').ok).toBe(false);    // mixed case
    expect(validateAddress('cosmos', 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd03').ok).toBe(false);
    expect(validateAddress('ton', 'EQ123').ok).toBe(false);
    expect(validateAddress('near', 'Bad Account').ok).toBe(false);
    expect(validateAddress('cex', 'short').ok).toBe(false);
    expect(validateAddress('evm', '').ok).toBe(false);
  });
  it('flags mixed-case EVM addresses as unchecked and never claims checksum validity', () => {
    const r = validateAddress('evm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362'); expect(r.ok && r.warnings.join(' ')).toMatch(/EIP-55 checksum is not verified/);
  });
  it('refuses seed phrases, private keys, WIF and Solana keypairs in ANY family', () => {
    for (const f of FAMILIES.map((x) => x.id)) {
      const r = validateAddress(f, SEED12); expect(r.ok).toBe(false); expect(!r.ok && r.secret).toBe(true);
      expect(validateAddress(f, 'my private key is here').ok).toBe(false);
    }
    expect(validateAddress('evm', '0x' + '11'.repeat(32))).toMatchObject({ ok: false, secret: true });
    expect(validateAddress('evm', '11'.repeat(32))).toMatchObject({ ok: false, secret: true });
    expect(validateAddress('svm', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toMatchObject({ ok: false });
    expect(validateAddress('bitcoin', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toMatchObject({ ok: false, secret: true });
    expect(validateAddress('svm', '3'.repeat(88))).toMatchObject({ ok: false });
    expect(secretHint(SEED12)).toMatch(/seed phrase/);
    expect(secretHint('0x9a4fc2bc7897dd21305b92c0e5cb86dffc984362')).toBeNull();
    // 64-hex is a legitimate id for Sui/Aptos/NEAR-implicit only
    expect(validateAddress('sui', '0x' + '11'.repeat(32)).ok).toBe(true);
    expect(validateAddress('near', '11'.repeat(32)).ok).toBe(true);
  });
  it('base58/bech32 primitives', () => {
    expect(base58Decode('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')?.length).toBe(32);
    expect(base58Decode('0OIl')).toBeNull();
    expect(Array.from(base58Decode('11')!)).toEqual([0, 0]);
    expect(bech32Check('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toMatchObject({ hrp: 'bc', variant: 'bech32' });
    expect(bech32Check('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')).toMatchObject({ variant: 'bech32m' });
  });
});

describe('basket weights', () => {
  it('parses percentages to bps', () => { expect(parsePct('33.33')).toBe(3333); expect(parsePct('100')).toBe(10000); expect(parsePct('0.5')).toBe(50); expect(parsePct('100.01')).toBeNull(); expect(parsePct('1.234')).toBeNull(); expect(parsePct('abc')).toBeNull(); expect(parsePct('-1')).toBeNull(); });
  it('blocks save unless the total is exactly 100%', () => {
    expect(weightSummary([{ asset: 'a', bps: 6000 }, { asset: 'b', bps: 4000 }])).toMatchObject({ total: 10000, canSave: true, remaining: 0 });
    expect(weightSummary([{ asset: 'a', bps: 6000 }, { asset: 'b', bps: 3999 }])).toMatchObject({ canSave: false, remaining: 1 });
    expect(weightSummary([{ asset: 'a', bps: 6000 }, { asset: 'b', bps: 4001 }]).problems.join()).toMatch(/over 100%/);
    expect(weightSummary([{ asset: 'a', bps: 5000 }, { asset: 'a', bps: 5000 }]).canSave).toBe(false);
    expect(weightSummary([{ asset: 'a', bps: null }]).canSave).toBe(false);
    expect(weightSummary([]).canSave).toBe(false);
    expect(weightSummary([{ asset: '', bps: 10000 }]).canSave).toBe(false);
  });
  it('rebalance preview uses BigInt units, decimal-normalised, truncating toward zero', () => {
    const m = [{ asset: 'u', symbol: 'USDC', decimals: 6, weight_bps: 5000 }, { asset: 'd', symbol: 'DAI', decimals: 18, weight_bps: 5000 }];
    const r = rebalancePreview(m, [{ asset: 'u', symbol: 'USDC', decimals: 6, amount: '700000000' }, { asset: 'd', symbol: 'DAI', decimals: 18, amount: '300000000000000000000' }]);
    expect(r.totalNormalised).toBe(1000n * 10n ** 18n);
    expect(r.rows[0]).toMatchObject({ currentBps: 7000, driftBps: 2000, action: 'sell', deltaUnits: -200000000n });
    expect(r.rows[1]).toMatchObject({ currentBps: 3000, driftBps: -2000, action: 'buy', deltaUnits: 200n * 10n ** 18n });
    const empty = rebalancePreview(m, []); expect(empty.rows.every((x) => x.action === 'hold' && x.currentBps === 0)).toBe(true);
    const big = rebalancePreview([{ asset: 'a', symbol: 'A', decimals: 18, weight_bps: 10000 }], [{ asset: 'a', symbol: 'A', decimals: 18, amount: '123456789012345678901234567890' }, { asset: 'x', symbol: 'X', decimals: 6, amount: '5' }]);
    expect(big.rows[0].deltaUnits).toBe(0n); expect(big.outside.map((o) => o.symbol)).toEqual(['X']);
  });
  it('overlap and concentration', () => {
    expect(basketOverlaps([{ id: '1', name: 'A', members: [{ asset: 'x', symbol: 'X' }, { asset: 'y', symbol: 'Y' }] }, { id: '2', name: 'B', members: [{ asset: 'x', symbol: 'X' }] }])).toEqual([{ asset: 'x', symbol: 'X', baskets: ['A', 'B'] }]);
    expect(basketOverlaps([])).toEqual([]);
    expect(chainConcentration([{ chain_id: 'a', weight_bps: 3000 }, { chain_id: 'a', weight_bps: 2000 }, { chain_id: 'b', weight_bps: 5000 }]).map((x) => x.bps)).toEqual([5000, 5000]);
  });
});

describe('waterfall preview + policy', () => {
  it('splits like apply_waterfall: deficit, tax, bps parts, remainder to reinvest', () => {
    const r = waterfallPreview(1000n, 100n, { reinvestBps: 5000, vaultBps: 3000, crossBucketBps: 0, reserveBps: 2000, taxProvisionBps: 1000 });
    expect(r).toMatchObject({ eligible: 900n, tax: 90n, vault: 243n, cross: 0n, reserve: 162n, reinvest: 405n, sums: true });
    expect(waterfallPreview(50n, 100n, { reinvestBps: 10000, vaultBps: 0, crossBucketBps: 0, reserveBps: 0, taxProvisionBps: 0 })).toMatchObject({ eligible: 0n, deficitRecovered: 50n });
    expect(waterfallTotalBps({ reinvestBps: 5000, vaultBps: 3000, crossBucketBps: 1000, reserveBps: 1000 })).toBe(10000);
    for (const g of [1n, 7n, 999999999999999999999n]) expect(waterfallPreview(g, 0n, { reinvestBps: 3333, vaultBps: 3333, crossBucketBps: 0, reserveBps: 3334, taxProvisionBps: 777 }).sums).toBe(true);
  });
  it('policy builder validates and round-trips; diff marks changes', () => {
    const { policy, errors } = buildPolicy({ max_slippage_bps: '50', max_open_orders: '5' }, '{"note":"x"}'); expect(errors).toEqual([]); expect(policy).toEqual({ note: 'x', max_slippage_bps: 50, max_open_orders: 5 });
    expect(buildPolicy({ max_slippage_bps: '10001' }, '').errors.length).toBe(1);
    expect(buildPolicy({ max_open_orders: '1.5' }, '').errors.length).toBe(1);
    expect(buildPolicy({}, '[1]').errors.length).toBe(1); expect(buildPolicy({}, '{bad').errors.length).toBe(1);
    expect(policyToFields(policy).fields.max_slippage_bps).toBe('50');
    const d = diffPolicy({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 4 });
    expect(d.map((x) => `${x.key}:${x.kind}`)).toEqual(['a:same', 'b:changed', 'c:removed', 'd:added']);
  });
  it('money helpers used by the forms are BigInt exact', () => { expect(parseUnits('12.5', 6)).toBe('12500000'); expect(formatUnits('123456789012345678901234567890', 18)).toBe('123,456,789,012.345678'); expect(() => parseUnits('1.1234567', 6)).toThrow(); });
});
