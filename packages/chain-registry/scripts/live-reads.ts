// LIVE READ-ONLY verification. Exercises each chain package's real client over real public RPCs (no keys, no writes, no signing).
// Output: src/live-evidence.generated.ts (consumed by the registry => READ_ONLY) and docs/evidence/chains-a-live-reads.md.
// A chain is PASS only if a candidate RPC returned the EXPECTED chain id/genesis/identifier; BLOCKED otherwise, with the exact error.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyCapabilities } from '@apex/contracts';
import type { CapabilityMap } from '@apex/contracts';
import * as evm from '@apex/chain-evm';
import * as sol from '@apex/chain-solana';
import * as sui from '@apex/chain-sui';
import * as apt from '@apex/chain-aptos';
import { EVM_CHAINS, EXTRA_EVM_CHAINS, SOLANA_CHAINS, MOVE_CHAINS } from '../src/index.ts';
import type { LiveEvidence, LiveCheck } from '../src/live-evidence.generated.ts';

const OUT_TS = fileURLToPath(new URL('../src/live-evidence.generated.ts', import.meta.url));
const OUT_MD = fileURLToPath(new URL('../../../docs/evidence/chains-a-live-reads.md', import.meta.url));
const DEAD = '0x000000000000000000000000000000000000dEaD';
const GWEI = 1_000_000_000n;
const msg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
const probeCaps = (): CapabilityMap => { const m = emptyCapabilities('PENDING'); for (const c of ['getBalances', 'getFeeQuote'] as const) m[c] = { status: 'READ_ONLY', evidenceRef: 'probe' }; return m; };

type Runner = (rpc: string) => Promise<{ checks: LiveCheck[]; capabilities: string[] }>;

async function step(checks: LiveCheck[], name: string, fn: () => Promise<string>): Promise<boolean> {
  try { checks.push({ name, ok: true, detail: await fn() }); return true; } catch (e) { checks.push({ name, ok: false, detail: msg(e) }); return false; }
}

// ---------------- EVM ----------------
function evmRunner(chainId: string): Runner {
  const numeric = BigInt(chainId.split(':')[1]!);
  return async (rpc) => {
    const checks: LiveCheck[] = []; const caps: string[] = [];
    const client = new evm.EvmRpcClient({ expectedChainId: numeric, transport: evm.httpTransport(rpc) });
    if (!(await step(checks, 'eth_chainId matches expected', async () => `${await client.verifyChainId()}`))) return { checks, capabilities: caps };
    await step(checks, 'eth_blockNumber', async () => `${await client.blockNumber()}`);
    if (await step(checks, 'eth_getBalance (getBalances)', async () => `${await client.getBalance(DEAD)} wei`)) caps.push('getBalances');
    const policy: evm.FeePolicy = { baseFeeMultiplierBps: 20_000n, minPriorityFeePerGas: 0n, maxPriorityFeePerGas: 50n * GWEI, maxFeePerGasCap: 100_000n * GWEI, rewardPercentileIndex: 1 };
    if (await step(checks, 'fee quote (getFeeQuote)', async () => { const { gas, source } = await evm.fetchGasQuote(client, policy); return `${source}: ${JSON.stringify(gas, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`; })) caps.push('getFeeQuote');
    if (await step(checks, 'simulate eth_call+estimateGas (simulate)', async () => { const r = await evm.simulate(client, { from: DEAD, to: DEAD, value: 0n }); if (!r.ok) throw new Error(`simulate not ok: ${JSON.stringify(r.revert)}`); return `gasEstimate=${r.gasEstimate}`; })) caps.push('simulate');
    let finalized = false;
    if (await step(checks, 'finalized block tag', async () => { const b = await client.getBlock('finalized'); if (!b) throw new Error('null'); return `finalized=${b.number}`; })) finalized = true;
    // transaction status through the adapter on a real recent transaction
    await step(checks, 'getTransactionStatus (adapter on a recent real tx)', async () => {
      const head = await client.blockNumber();
      let hash: string | undefined;
      for (let back = 12n; back < 60n && !hash; back += 4n) {
        const b = (await client.request('eth_getBlockByNumber', ['0x' + (head - back).toString(16), true])) as { transactions?: { hash: string }[] } | null;
        hash = b?.transactions?.[0]?.hash;
      }
      if (!hash) throw new Error('no transaction found in recent blocks');
      const caps2 = probeCaps();
      const a = new evm.EvmChainAdapter({ capabilitiesFor: () => caps2, clientFor: () => client, feePolicyFor: () => policy, reserveConfigFor: () => ({ floor: 0n, perTxCost: 0n, emergencyExitCost: 0n }) });
      const st = await a.getTransactionStatus(chainId, hash);
      if (!['included', 'final', 'failed'].includes(st.state)) throw new Error(`unexpected state ${st.state}`);
      caps.push('getTransactionStatus'); if (finalized) caps.push('finalityStatus');
      return `${hash.slice(0, 18)}… => ${st.state}${st.confirmations ? ` (${st.confirmations} confirmations)` : ''}`;
    });
    const spec = evm.l2FeeSpec(numeric);
    if (spec.stack === 'op-stack' && spec.modelled) await step(checks, 'OP GasPriceOracle.getL1Fee (info only)', async () => `${await evm.opL1Fee(client, '0x' + 'ab'.repeat(100))} wei for 100 bytes`);
    if (spec.stack === 'arbitrum') await step(checks, 'Arbitrum NodeInterface.gasEstimateComponents (info only)', async () => { const r = await evm.arbL1Component(client, DEAD, '0x'); return `gasEstimateForL1=${r.gasEstimateForL1} baseFee=${r.baseFee} l1FeeWei=${r.l1FeeWei}`; });
    return { checks, capabilities: [...new Set(caps)] };
  };
}

// ---------------- Solana ----------------
function solRunner(chainId: 'solana:mainnet' | 'solana:devnet' | 'solana:testnet'): Runner {
  return async (rpc) => {
    const checks: LiveCheck[] = []; const caps: string[] = [];
    const client = new sol.SolanaRpcClient({ expectedGenesisHash: sol.SOLANA_GENESIS_HASHES[chainId], transport: sol.httpTransport(rpc) });
    if (!(await step(checks, 'getGenesisHash matches expected', async () => { await client.verifyCluster(); return sol.SOLANA_GENESIS_HASHES[chainId]; }))) return { checks, capabilities: caps };
    await step(checks, 'getHealth', async () => client.getHealth());
    await step(checks, 'getSlot', async () => `${await client.getSlot()}`);
    await step(checks, 'getBlockHeight', async () => `${await client.getBlockHeight()}`);
    await step(checks, 'getLatestBlockhash', async () => { const b = await client.getLatestBlockhash(); return `${b.blockhash} lastValidBlockHeight=${b.lastValidBlockHeight}`; });
    const caps2 = probeCaps();
    const adapter = new sol.SolanaChainAdapter({ capabilitiesFor: () => caps2, clientFor: () => client, reserveConfigFor: () => ({ perTxCost: 10_000n, emergencyExitCost: 20_000n }) });
    if (await step(checks, 'getBalance (getBalances)', async () => `${(await adapter.getBalances(chainId, '11111111111111111111111111111111'))[0]!.amount} lamports`)) caps.push('getBalances');
    if (await step(checks, 'getRecentPrioritizationFees (getFeeQuote)', async () => { const q = await adapter.getFeeQuote(chainId); return `${q.nativeUnits} lamports; ${q.source}`; })) caps.push('getFeeQuote');
    await step(checks, 'getTokenAccountsByOwner (jsonParsed)', async () => `${(await client.getTokenAccountsByOwner('11111111111111111111111111111111', { programId: sol.TOKEN_PROGRAM_ID })).length} accounts`);
    await step(checks, 'rent schedule derived from node (rentParamsFromNode; legacy constant is STALE)', async () => {
      const p = await sol.rentParamsFromNode(client);
      return `${p.lamportsPerByte} lamports/byte => 0B=${sol.rentExemptMinimum(0, p)}, 165B=${sol.rentExemptMinimum(165, p)}, ATA(Token-2022,170B)=${sol.rentExemptMinimum(170, p)}; legacy default would say 165B=${sol.rentExemptMinimum(165)}`;
    });
    await step(checks, 'getTransactionStatus (adapter on a recent finalized signature)', async () => {
      const sigs = (await client.request('getSignaturesForAddress', ['11111111111111111111111111111111', { limit: 3, commitment: 'finalized' }])) as { signature: string }[];
      if (!sigs.length) throw new Error('no signatures');
      const st = await adapter.getTransactionStatus(chainId, sigs[0]!.signature);
      if (!['included', 'final', 'failed'].includes(st.state)) throw new Error(`unexpected state ${st.state}: ${st.detail}`);
      caps.push('getTransactionStatus', 'finalityStatus');
      return `${sigs[0]!.signature.slice(0, 16)}… => ${st.state}`;
    });
    if (chainId === 'solana:mainnet') {
      await step(checks, 'getAccountInfo + parseMint USDC (getTokenMetadata)', async () => {
        const ai = await client.getAccountInfo('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); if (!ai) throw new Error('null');
        const m = sol.parseMint(ai.data, ai.owner); if (m.decimals !== 6) throw new Error(`decimals ${m.decimals}`);
        caps.push('getTokenMetadata'); return `decimals=${m.decimals} program=${m.program} risk=${sol.analyzeMint(m).severity}`;
      });
      await step(checks, 'getAccountInfo + analyzeMint PYUSD Token-2022 (info)', async () => {
        const ai = await client.getAccountInfo('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'); if (!ai) throw new Error('null');
        const r = sol.analyzeMint(sol.parseMint(ai.data, ai.owner)); return `extensions=${r.extensionNames.join(',')} severity=${r.severity} flags=${r.flags.map((f) => f.code).join(',')}`;
      });
    }
    return { checks, capabilities: [...new Set(caps)] };
  };
}

// ---------------- Sui ----------------
function suiRunner(chainId: 'sui:mainnet' | 'sui:testnet'): Runner {
  return async (rpc) => {
    const checks: LiveCheck[] = []; const caps: string[] = [];
    const client = new sui.SuiRpcClient({ expectedChainIdentifier: sui.SUI_CHAIN_IDENTIFIERS[chainId], transport: sui.httpTransport(rpc) });
    if (!(await step(checks, 'sui_getChainIdentifier matches expected', async () => { await client.verifyChain(); return sui.SUI_CHAIN_IDENTIFIERS[chainId]; }))) return { checks, capabilities: caps };
    const owner = '0x' + '0'.repeat(63) + '5';
    const caps2 = probeCaps();
    const adapter = new sui.SuiChainAdapter({ capabilitiesFor: () => caps2, clientFor: () => client, reserveConfigFor: () => ({ floor: 0n, perTxBudget: 1n, emergencyExitBudget: 1n }) });
    if (await step(checks, 'suix_getBalance (getBalances)', async () => { const b = await client.getBalance(owner); return `${b.total} MIST in ${b.coinObjectCount} coin objects; fundsInAddressBalance=${b.fundsInAddressBalance ?? 'n/a'}`; })) caps.push('getBalances');
    if (await step(checks, 'suix_getReferenceGasPrice (getFeeQuote; INCOMPLETE: storage unknown)', async () => { const q = await adapter.getFeeQuote(chainId); return `${q.source}`; })) caps.push('getFeeQuote');
    await step(checks, 'suix_getCoins pagination', async () => `${(await client.getCoinsPage(owner, '0x2::sui::SUI', null, 5)).coins.length} coins`);
    await step(checks, 'sui_getObject (shared Clock 0x6)', async () => { const o = await client.getObject('0x' + '0'.repeat(63) + '6'); if (!o) throw new Error('null'); return `version=${o.version} owner=${JSON.stringify(o.owner)}`; });
    await step(checks, 'sui_getLatestCheckpointSequenceNumber', async () => `${await client.getLatestCheckpoint()}`);
    await step(checks, 'getTransactionStatus (adapter on a recent real digest)', async () => {
      const q = (await client.request('suix_queryTransactionBlocks', [{ filter: null, options: {} }, null, 1, true])) as { data: { digest: string }[] };
      const d = q.data[0]?.digest; if (!d) throw new Error('no digest');
      const st = await adapter.getTransactionStatus(chainId, d);
      if (!['final', 'included', 'failed'].includes(st.state)) throw new Error(`unexpected ${st.state}`);
      caps.push('getTransactionStatus', 'finalityStatus'); return `${d.slice(0, 12)}… => ${st.state} (${st.detail})`;
    });
    return { checks, capabilities: [...new Set(caps)] };
  };
}

// ---------------- Aptos ----------------
function aptosRunner(chainId: 'aptos:mainnet' | 'aptos:testnet'): Runner {
  return async (base) => {
    const checks: LiveCheck[] = []; const caps: string[] = [];
    const transport = apt.httpTransport(base);
    const client = new apt.AptosRestClient({ expectedChainId: apt.APTOS_CHAIN_IDS[chainId], transport });
    if (!(await step(checks, 'GET /v1 chain_id matches expected', async () => { await client.verifyChain(); return `chain_id=${apt.APTOS_CHAIN_IDS[chainId]}`; }))) return { checks, capabilities: caps };
    const caps2 = probeCaps();
    const adapter = new apt.AptosChainAdapter({ capabilitiesFor: () => caps2, clientFor: () => client, reserveConfigFor: () => ({ floor: 0n, perTxMaxCost: 1n, emergencyExitMaxCost: 1n }) });
    await step(checks, 'ledger info', async () => { const l = await client.ledgerInfo(); return `block_height=${l.blockHeight} ledger_version=${l.ledgerVersion} ts=${l.ledgerTimestampUsec}`; });
    await step(checks, 'GET /-/healthy', async () => `${await client.isHealthy()}`);
    if (await step(checks, 'GET account balance (getBalances)', async () => `${(await adapter.getBalances(chainId, '0x1'))[0]!.amount} octas`)) caps.push('getBalances');
    if (await step(checks, 'GET /estimate_gas_price (getFeeQuote)', async () => (await adapter.getFeeQuote(chainId)).source)) caps.push('getFeeQuote');
    await step(checks, 'GET account sequence_number', async () => `${(await client.getAccount('0x1')).sequenceNumber}`);
    await step(checks, 'getTransactionStatus (adapter on a recent user txn)', async () => {
      const r = await transport({ method: 'GET', path: '/transactions?limit=25' });
      const list = JSON.parse(r.body) as { type: string; hash: string }[];
      const t = list.find((x) => x.type === 'user_transaction'); if (!t) throw new Error('no user transaction in last 25');
      const st = await adapter.getTransactionStatus(chainId, t.hash);
      if (!['final', 'failed'].includes(st.state)) throw new Error(`unexpected ${st.state}`);
      caps.push('getTransactionStatus', 'finalityStatus'); return `${t.hash.slice(0, 14)}… => ${st.state}`;
    });
    return { checks, capabilities: [...new Set(caps)] };
  };
}

interface Target { chainId: string; rpcs: string[]; run: Runner }
const targets: Target[] = [
  ...[...EVM_CHAINS, ...EXTRA_EVM_CHAINS].map((r) => ({ chainId: r.id, rpcs: r.rpcCandidates, run: evmRunner(r.id) })),
  ...SOLANA_CHAINS.map((r) => ({ chainId: r.id, rpcs: r.rpcCandidates, run: solRunner(r.id as 'solana:mainnet') })),
  ...MOVE_CHAINS.map((r) => ({ chainId: r.id, rpcs: r.rpcCandidates, run: r.family === 'sui' ? suiRunner(r.id as 'sui:mainnet') : aptosRunner(r.id as 'aptos:mainnet') })),
];
const only = process.env.ONLY?.split(',');

const results: Record<string, LiveEvidence> = {};
for (const t of targets) {
  if (only && !only.includes(t.chainId)) continue;
  const attempts: LiveEvidence['attempts'] = [];
  let best: { rpc: string; checks: LiveCheck[]; capabilities: string[] } | null = null;
  for (const rpc of t.rpcs) {
    try {
      const r = await t.run(rpc);
      const ok = r.checks[0]?.ok === true; // first check is always the chain identity check
      attempts.push({ rpc, ok, ...(ok ? {} : { error: r.checks[0]?.detail ?? 'no result' }) });
      if (ok) { best = { rpc, ...r }; break; }
    } catch (e) { attempts.push({ rpc, ok: false, error: msg(e) }); }
  }
  const at = new Date().toISOString();
  results[t.chainId] = best
    ? { chainId: t.chainId, status: 'PASS', rpc: best.rpc, at, checks: best.checks, capabilities: best.capabilities, attempts }
    : { chainId: t.chainId, status: 'BLOCKED', rpc: null, at, checks: [], capabilities: [], attempts };
  for (const c of best?.checks ?? []) if (!c.ok) console.log(`   FAIL ${c.name}: ${c.detail}`);
  console.log(`${t.chainId}: ${results[t.chainId]!.status} ${best?.rpc ?? attempts.map((a) => a.error).join(' | ')} caps=[${best?.capabilities.join(',') ?? ''}]`);
}
if (only) { console.log('ONLY set: not writing evidence files'); process.exit(0); }

writeFileSync(OUT_TS, `// GENERATED by scripts/live-reads.ts at ${new Date().toISOString()} — do not edit by hand.
export interface LiveCheck { name: string; ok: boolean; detail: string }
export interface LiveEvidence { chainId: string; status: 'PASS' | 'BLOCKED'; rpc: string | null; at: string; checks: LiveCheck[]; capabilities: string[]; attempts: { rpc: string; ok: boolean; error?: string }[] }
export const LIVE_EVIDENCE: Record<string, LiveEvidence> = ${JSON.stringify(results, null, 2)};
`);

const md: string[] = [];
md.push('# Families A: live read-only verification', '', `Generated by \`pnpm --filter @apex/chain-registry live\` (scripts/live-reads.ts) at ${new Date().toISOString()}.`, '',
  'Method: each chain package\'s real client (EvmRpcClient / SolanaRpcClient / SuiRpcClient / AptosRestClient) was pointed at public RPC endpoints without API keys. Only read methods were used (no signing, no submission). A chain is **PASS** only if an endpoint returned the EXPECTED chain id / genesis hash / chain identifier; otherwise **BLOCKED** with the exact error. The registry marks a capability `READ_ONLY` only if the matching read succeeded here; nothing is `CERTIFIED`.', '',
  '| Chain | Result | Endpoint used | Capabilities proven READ_ONLY |', '|---|---|---|---|');
for (const r of Object.values(results)) md.push(`| ${r.chainId} | ${r.status} | ${r.rpc ?? '-'} | ${r.capabilities.join(', ') || '-'} |`);
md.push('');
for (const r of Object.values(results)) {
  md.push(`## ${r.chainId}`, '', `Result: **${r.status}** (${r.at})`, '', 'Endpoint attempts:', '');
  for (const a of r.attempts) md.push(`- ${a.ok ? 'PASS' : 'BLOCKED'} \`${a.rpc}\`${a.error ? ` -- ${a.error.replace(/\n/g, ' ')}` : ''}`);
  if (r.checks.length) { md.push('', '| Check | Result | Detail |', '|---|---|---|'); for (const c of r.checks) md.push(`| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`); }
  md.push('');
}
writeFileSync(OUT_MD, md.join('\n'));
console.log('wrote evidence files');
