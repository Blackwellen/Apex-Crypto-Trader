import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, assertCertified, CapabilityNotCertified, emptyCapabilities } from '@apex/contracts';
import type { ChainRecord } from '@apex/contracts';
import {
  buildRegistry, registerChains, clearRegisteredChains, applyLiveEvidence, baseChains, makeExtraEvmChain, EVM_CHAINS, EXTRA_EVM_CHAINS, SOLANA_CHAINS, MOVE_CHAINS,
  EXTERNAL_FAMILIES, LIVE_EVIDENCE, LIVE_EVIDENCE_DOC, Registry,
} from '../src/index.ts';
import type { LiveEvidence } from '../src/index.ts';

afterEach(() => clearRegisteredChains());
const EVIDENCE_MD = fileURLToPath(new URL('../../../docs/evidence/chains-a-live-reads.md', import.meta.url));

// Facts verified against https://chainid.network/chains.json (ethereum-lists/chains) + live eth_chainId (see docs/evidence).
const EXPECT_EVM: Record<string, [string, string, number]> = {
  'eip155:1': ['Ethereum', 'ETH', 18], 'eip155:8453': ['Base', 'ETH', 18], 'eip155:42161': ['Arbitrum One', 'ETH', 18], 'eip155:10': ['OP Mainnet', 'ETH', 18],
  'eip155:137': ['Polygon PoS', 'POL', 18], 'eip155:56': ['BNB Smart Chain', 'BNB', 18], 'eip155:43114': ['Avalanche C-Chain', 'AVAX', 18], 'eip155:59144': ['Linea', 'ETH', 18],
  'eip155:534352': ['Scroll', 'ETH', 18], 'eip155:324': ['zkSync Era', 'ETH', 18], 'eip155:5000': ['Mantle', 'MNT', 18], 'eip155:81457': ['Blast', 'ETH', 18],
};

test('registry contains every network required by spec section 2 (all 9 families)', () => {
  const reg = buildRegistry();
  for (const [id, [name, sym, dec]] of Object.entries(EXPECT_EVM)) {
    const r = reg.require(id); assert.equal(r.name, name); assert.equal(r.nativeSymbol, sym); assert.equal(r.nativeDecimals, dec); assert.equal(r.family, 'evm'); assert.equal(r.isTestnet, false);
    assert.equal(r.chainRef, id.split(':')[1]);
  }
  assert.equal(reg.require('solana:mainnet').nativeSymbol, 'SOL'); assert.equal(reg.require('solana:mainnet').nativeDecimals, 9);
  assert.equal(reg.require('solana:devnet').isTestnet, true);
  assert.equal(reg.require('sui:mainnet').nativeDecimals, 9); assert.equal(reg.require('sui:mainnet').nativeSymbol, 'SUI');
  assert.equal(reg.require('aptos:mainnet').nativeDecimals, 8); assert.equal(reg.require('aptos:mainnet').nativeSymbol, 'APT');
  assert.deepEqual([...new Set(reg.records.map((r) => r.family))].sort(), ['aptos', 'bitcoin', 'cosmos', 'evm', 'near', 'sui', 'svm', 'ton', 'tron']);
});
test('EVM numeric chain ids in records equal the expected EIP-155 ids', () => {
  const ids = { 'eip155:1': 1, 'eip155:8453': 8453, 'eip155:42161': 42161, 'eip155:10': 10, 'eip155:137': 137, 'eip155:56': 56, 'eip155:43114': 43114, 'eip155:59144': 59144, 'eip155:534352': 534352, 'eip155:324': 324, 'eip155:5000': 5000, 'eip155:81457': 81457 };
  for (const [id, n] of Object.entries(ids)) assert.equal(buildRegistry().require(id).chainRef, String(n));
});
test('every record: disabled by default, provenance present, flags consistent, urls https', () => {
  for (const r of buildRegistry().records as readonly (ChainRecord & { verifiedFrom: string[]; unverified: boolean; unverifiedFields: string[]; meta: object })[]) {
    assert.equal(r.enabled, false, `${r.id} must ship disabled`);
    assert.ok(r.verifiedFrom.length > 0, `${r.id} verifiedFrom`);
    assert.equal(r.unverified, r.unverifiedFields.length > 0, `${r.id} unverified flag consistent`);
    assert.equal(r.id, `${r.namespace}:${r.chainRef}`);
    assert.match(r.explorerUrl ?? '', /^https:\/\//); for (const u of r.rpcCandidates) assert.match(u, /^https:\/\//);
    assert.ok(r.verifiedFrom.every((v) => /https?:\/\/|observed live/.test(v)), `${r.id} provenance cites a source`);
  }
});
test('anything not verified against official docs is flagged unverified (Linea/Scroll docs pages could not be confirmed)', () => {
  const reg = buildRegistry();
  for (const id of ['eip155:59144', 'eip155:534352']) { const r = reg.require(id) as unknown as { unverified: boolean; unverifiedFields: string[] }; assert.equal(r.unverified, true); assert.ok(r.unverifiedFields.includes('officialDocsChainId')); }
  for (const r of EXTRA_EVM_CHAINS) assert.ok((r as unknown as { unverified: boolean }).unverified);
  assert.equal((reg.require('eip155:1') as unknown as { unverified: boolean }).unverified, false, 'Ethereum: id, symbol, explorer, finality all verified');
});
test('chain ids are unique and the registry rejects duplicates', () => {
  const ids = buildRegistry().records.map((r) => r.id); assert.equal(new Set(ids).size, ids.length);
  assert.throws(() => new Registry([EVM_CHAINS[0]!, EVM_CHAINS[0]!]), /duplicate/);
});

test('NO capability is CERTIFIED anywhere and none is CERTIFIED without evidenceRef', () => {
  for (const r of buildRegistry().records) for (const cap of CAPABILITIES) {
    const c = r.capabilities[cap]; assert.notEqual(c.status, 'CERTIFIED', `${r.id}.${cap}`);
    if (c.status === 'CERTIFIED') assert.ok(c.evidenceRef);
  }
});
test('assertCertified throws for EVERY chain x capability (fail closed)', () => {
  let n = 0;
  for (const r of buildRegistry().records) for (const cap of CAPABILITIES) {
    assert.throws(() => assertCertified(r.capabilities, r.id, cap), CapabilityNotCertified); n++;
  }
  assert.equal(n, buildRegistry().records.length * 26);
});
test('execution capabilities (swap, transfer, submit, bridge*, signThroughPolicyService, buildTransaction) are never READ_ONLY or better', () => {
  for (const r of buildRegistry().records) for (const cap of ['swap', 'transfer', 'submit', 'bridgeSubmit', 'bridgeQuote', 'signThroughPolicyService', 'buildTransaction', 'buildSwapQuote'] as const)
    assert.ok(['PENDING', 'UNSUPPORTED'].includes(r.capabilities[cap].status), `${r.id}.${cap}`);
});
test('READ_ONLY only where a live read PASSED and recorded it; evidenceRef points at the evidence doc', () => {
  for (const r of buildRegistry().records) {
    const ev = LIVE_EVIDENCE[r.id];
    for (const cap of CAPABILITIES) {
      const c = r.capabilities[cap];
      if (c.status === 'READ_ONLY') {
        assert.ok(ev && ev.status === 'PASS', `${r.id}.${cap} is READ_ONLY without a passing live read`);
        assert.ok(ev.capabilities.includes(cap)); assert.equal(c.evidenceRef, `${LIVE_EVIDENCE_DOC}#${r.id}`);
        assert.ok(ev.checks.some((k) => k.ok), 'at least one successful check recorded');
      }
    }
    if (ev && ev.status === 'BLOCKED') assert.ok(CAPABILITIES.every((cap) => r.capabilities[cap].status !== 'READ_ONLY'), `${r.id} BLOCKED => no READ_ONLY`);
  }
});
test('applyLiveEvidence: BLOCKED => nothing READ_ONLY; unknown capability name throws; UNSUPPORTED is never upgraded', () => {
  const rec = EVM_CHAINS[1]!;
  const mk = (status: 'PASS' | 'BLOCKED', capabilities: string[]): Record<string, LiveEvidence> => ({ [rec.id]: { chainId: rec.id, status, rpc: 'x', at: 't', checks: [{ name: 'c', ok: true, detail: '' }], capabilities, attempts: [] } });
  assert.ok(CAPABILITIES.every((c) => applyLiveEvidence(rec, mk('BLOCKED', ['getBalances'])).capabilities[c].status !== 'READ_ONLY'));
  assert.equal(applyLiveEvidence(rec, mk('PASS', ['getBalances'])).capabilities.getBalances.status, 'READ_ONLY');
  assert.equal(applyLiveEvidence(rec, mk('PASS', ['supportsNativeOrderBook'])).capabilities.supportsNativeOrderBook.status, 'UNSUPPORTED');
  assert.throws(() => applyLiveEvidence(rec, mk('PASS', ['notACapability'])), /unknown capability/);
  assert.equal(rec.capabilities.getBalances.status, 'PENDING', 'input record is not mutated');
});
test('live evidence exists for every base chain (PASS or BLOCKED) and the evidence doc names each one', () => {
  assert.ok(existsSync(EVIDENCE_MD), 'docs/evidence/chains-a-live-reads.md must exist');
  const md = readFileSync(EVIDENCE_MD, 'utf8');
  for (const r of baseChains()) { assert.ok(LIVE_EVIDENCE[r.id], `no live evidence entry for ${r.id}`); assert.ok(md.includes(`## ${r.id}`), `doc lacks ${r.id}`); assert.ok(['PASS', 'BLOCKED'].includes(LIVE_EVIDENCE[r.id]!.status)); }
});

test('registerChains merge point: adds records, idempotent for identical, rejects conflicts / CERTIFIED-without-evidence / enabled', () => {
  const tron: ChainRecord = { id: 'tron:mainnet', namespace: 'tron', chainRef: 'mainnet', family: 'tron', name: 'TRON', isTestnet: false, nativeSymbol: 'TRX', nativeDecimals: 6, finalityModel: 'x', addressFormat: 'base58check', rpcCandidates: [], enabled: false, capabilities: emptyCapabilities() };
  const before = buildRegistry().records.length;
  registerChains([tron]); registerChains([tron]);
  assert.equal(buildRegistry().records.length, before + 1); assert.equal(buildRegistry().require('tron:mainnet').family, 'tron');
  assert.throws(() => registerChains([{ ...tron, name: 'Other' }]), /conflicting duplicate/);
  assert.throws(() => registerChains([{ ...tron, id: 'tron:x', chainRef: 'x', capabilities: { ...emptyCapabilities(), swap: { status: 'CERTIFIED' } } }]), /CERTIFIED without evidenceRef/);
  assert.throws(() => registerChains([{ ...tron, id: 'tron:y', chainRef: 'y', enabled: true }]), /enabled=false/);
  assert.throws(() => registerChains([{ ...tron, id: 'tron:z' }]), /namespace:chainRef/);
  assert.throws(() => registerChains([{ ...tron, id: 'eip155:1', namespace: 'eip155', chainRef: '1', family: 'evm' }]), /collides with a base chain/, 'collision with a base chain is rejected immediately');
});
test('registerChains has no effect on base chains and families list the external families', () => {
  assert.deepEqual([...EXTERNAL_FAMILIES].sort(), ['bitcoin', 'cosmos', 'near', 'ton', 'tron']);
  assert.equal(buildRegistry().records.length, EVM_CHAINS.length + EXTRA_EVM_CHAINS.length + SOLANA_CHAINS.length + MOVE_CHAINS.length);
});
test('makeExtraEvmChain demands a cited verification source and ships disabled/PENDING', () => {
  assert.throws(() => makeExtraEvmChain({ chainId: 999, name: 'X', nativeSymbol: 'X', explorerUrl: 'https://x', rpcCandidates: [], finalityModel: 'x', verifiedFrom: [] }), /verifiedFrom is required/);
  assert.throws(() => makeExtraEvmChain({ chainId: -1, name: 'X', nativeSymbol: 'X', explorerUrl: 'https://x', rpcCandidates: [], finalityModel: 'x', verifiedFrom: ['y'] }), /positive integer/);
  const r = makeExtraEvmChain({ chainId: 4242, name: 'Foo', nativeSymbol: 'FOO', explorerUrl: 'https://foo.scan', rpcCandidates: ['https://rpc.foo'], finalityModel: 'x', verifiedFrom: ['https://docs.foo/network'] });
  assert.equal(r.id, 'eip155:4242'); assert.equal(r.enabled, false); assert.equal(r.unverified, true); assert.ok(CAPABILITIES.every((c) => ['PENDING', 'UNSUPPORTED'].includes(r.capabilities[c].status)));
  registerChains([r]); assert.ok(buildRegistry().get('eip155:4242'));
});
