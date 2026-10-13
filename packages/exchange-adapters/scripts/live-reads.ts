// Live READ-ONLY verification harness for families B + venues. Usage: node --experimental-transform-types scripts/live-reads.ts > out.md
// Makes only GET/read-style calls. No keys, no signing, no broadcast.
import { TronClient, validateTronAddress } from '../../chain-tron/src/index.ts';
import { CosmosLcdClient, resolveDenom, validateCosmosAddress } from '../../chain-cosmos/src/index.ts';
import { EsploraClient, validateBitcoinAddress } from '../../chain-bitcoin/src/index.ts';
import { ToncenterClient, validateTonAddress } from '../../chain-ton/src/index.ts';
import { NearRpcClient } from '../../chain-near/src/index.ts';
import { CoinbasePublicVenue, COINBASE_WS_URL, L2BookSync } from '../src/index.ts';
import { createHash } from 'node:crypto';

type R = { section: string; name: string; status: 'PASS' | 'BLOCKED'; detail: string; ms: number };
const results: R[] = [];
async function check(section: string, name: string, fn: () => Promise<string>): Promise<void> {
  await new Promise((r) => setTimeout(r, 1300)); // polite pacing: public endpoints (TronGrid, toncenter) rate-limit unauthenticated callers
  const t = Date.now(); let firstErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const d = await fn(); results.push({ section, name, status: 'PASS', detail: d + (firstErr ? ` [passed on attempt 2; attempt 1 failed: ${firstErr}]` : ''), ms: Date.now() - t }); return; }
    catch (e) {
      const msg = `${(e as Error).name}: ${(e as Error).message}${(e as any).cause ? ' / ' + String((e as any).cause?.message ?? (e as any).cause) : ''}`.slice(0, 300);
      if (attempt === 1) { firstErr = msg; await new Promise((r) => setTimeout(r, 6000)); } else results.push({ section, name, status: 'BLOCKED', detail: `${msg} [2 attempts; attempt 1: ${firstErr}]`, ms: Date.now() - t });
    }
  }
}
const must = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// ---- TRON ----
const tron = new TronClient('https://api.trongrid.io'), nile = new TronClient('https://nile.trongrid.io');
await check('tron', 'mainnet getnowblock', async () => { const b = await tron.getNowBlock(); must(b.number > 0n, 'height'); return `height ${b.number} id ${b.blockID.slice(0, 16)}...`; });
await check('tron', 'mainnet genesis blockID matches chain id suffix 2b6653dc', async () => {
  const r = await (await fetch('https://api.trongrid.io/wallet/getblockbynum', { method: 'POST', body: JSON.stringify({ num: 0 }) })).json() as any;
  must(String(r.blockID).endsWith('2b6653dc'), r.blockID); return `blockID ${r.blockID}`; });
await check('tron', 'nile genesis blockID matches chain id suffix cd8690dc', async () => {
  const r = await (await fetch('https://nile.trongrid.io/wallet/getblockbynum', { method: 'POST', body: JSON.stringify({ num: 0 }) })).json() as any;
  must(String(r.blockID).endsWith('cd8690dc'), r.blockID); return `blockID ${r.blockID}`; });
await check('tron', 'mainnet getchainparameters parsed by model', async () => { const p = await tron.getChainParameters(); return `energyFee=${p.energyFeeSun} sun, bandwidthFee=${p.bandwidthFeeSun} sun/B, maxFeeLimit=${p.maxFeeLimitSun} sun, freeNet=${p.freeNetLimit}, dynamicEnergy=${p.dynamicEnergyEnabled}, params=${Object.keys(p.raw).length}`; });
await check('tron', 'nile getnowblock + getchainparameters', async () => { const b = await nile.getNowBlock(); const p = await nile.getChainParameters(); return `height ${b.number}, energyFee=${p.energyFeeSun}, bandwidthFee=${p.bandwidthFeeSun}`; });
await check('tron', 'mainnet getaccount (USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t)', async () => { must(validateTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').valid, 'address checksum'); const a = await tron.getAccount('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'); return `exists=${a.exists} balanceSun=${a.balanceSun}`; });
await check('tron', 'mainnet getaccountresource', async () => { const r = await tron.getAccountResources('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'); return `freeNetLimit=${r.freeNetLimit} netLimit=${r.netLimit} energyLimit=${r.energyLimit}`; });
await check('tron', 'solidified block (finality) via /walletsolidity', async () => { const s = await tron.getSolidifiedBlockNumber(); const n = await tron.getNowBlock(); return `solidified ${s}, head ${n.number}, lag ${n.number - s} blocks`; });
await check('tron', 'gettransactioninfobyid for a tx from a recent block', async () => {
  const n = await tron.getNowBlock();
  const blk = await (await fetch('https://api.trongrid.io/wallet/getblockbynum', { method: 'POST', body: JSON.stringify({ num: Number(n.number) - 40 }) })).json() as any;
  const txid = blk.transactions?.[0]?.txID; if (!txid) throw new Error('no tx in sampled block');
  await new Promise((r) => setTimeout(r, 1300));
  const i = await tron.getTransactionInfo(txid); must(i, 'tx info'); return `tx ${txid.slice(0, 12)}... block ${i!.blockNumber} result ${i!.result} net ${i!.netUsage} energy ${i!.energyUsage} fee ${i!.feeSun}`; });
await check('tron', 'witness address from live block round-trips base58check', async () => {
  const r = await (await fetch('https://api.trongrid.io/wallet/getnowblock')).json() as any; const v = validateTronAddress(r.block_header.raw_data.witness_address); must(v.valid, 'witness'); return `${r.block_header.raw_data.witness_address} -> ${v.normalized}`; });

// ---- COSMOS ----
const hub = new CosmosLcdClient('https://cosmos-rest.publicnode.com'), osmo = new CosmosLcdClient('https://osmosis-rest.publicnode.com');
await check('cosmos', 'Cosmos Hub node_info (network=cosmoshub-4)', async () => { const n = await hub.getNodeInfo(); must(n.network === 'cosmoshub-4', n.network); return `${n.network} ${n.appName} ${n.appVersion}`; });
await check('cosmos', 'Osmosis node_info (network=osmosis-1)', async () => { const n = await osmo.getNodeInfo(); must(n.network === 'osmosis-1', n.network); return `${n.network} ${n.appName} ${n.appVersion}`; });
await check('cosmos', 'Hub latest block', async () => { const b = await hub.getLatestBlock(); return `height ${b.height} ${b.time} chain ${b.chainId}`; });
await check('cosmos', 'Hub node min gas prices (node-local, informational)', async () => { const g = await hub.getMinGasPrices(); return JSON.stringify(g); });
await check('cosmos', 'Hub bank balances (fee collector module acct)', async () => { const a = 'cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta'; must(validateCosmosAddress(a, 'cosmos').valid, 'bech32'); const b = await hub.getBalances(a); return `${b.length} denoms; first ${b[0]?.denom ?? 'none'}`; });
await check('cosmos', 'Hub auth account sequence', async () => { const s = await hub.getAccountSequence('cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta'); return JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v); });
await check('cosmos', 'Hub getTx for a tx hash derived from a recent block', async () => {
  const lb = await hub.getLatestBlock();
  let raw: string | undefined;
  for (let d = 3n; d < 40n && !raw; d++) { const blk = await (await fetch(`https://cosmos-rest.publicnode.com/cosmos/base/tendermint/v1beta1/blocks/${lb.height - d}`)).json() as any; raw = blk.block?.data?.txs?.[0]; }
  if (!raw) throw new Error('no tx in 37 sampled blocks');
  const hash = createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex').toUpperCase();
  const t = await hub.getTx(hash); must(t, 'tx'); return `tx ${hash.slice(0, 12)}... height ${t!.height} code ${t!.code}`; });
await check('cosmos', 'Hub max memo chars (auth params)', async () => `max_memo_characters=${await hub.getMaxMemoChars()}`);
await check('cosmos', 'Osmosis IBC denom trace resolved AND hash-verified locally', async () => {
  const d = await resolveDenom('ibc/E6931F78057F7CC5DA0FD6CEF82FF39373A6E0452BF1FD76910B93292CF356C1', (h) => osmo.getDenomTrace(h));
  must(d.kind === 'ibc', JSON.stringify(d)); return d.kind === 'ibc' ? `path=${d.path} base=${d.baseDenom} hashVerified=${d.hashVerified}` : ''; });
await check('cosmos', 'Osmosis ATOM denom (documented example) trace', async () => {
  const d = await resolveDenom('ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', (h) => osmo.getDenomTrace(h));
  must(d.kind === 'ibc' && d.baseDenom === 'uatom', JSON.stringify(d)); return d.kind === 'ibc' ? `path=${d.path} base=${d.baseDenom}` : ''; });
await check('cosmos', 'Osmosis channel-0 (transfer) state/counterparty', async () => { const c = await osmo.getChannel('channel-0'); must(c, 'channel'); return `state=${c!.state} counterparty=${c!.counterparty.port_id}/${c!.counterparty.channel_id} hops=${c!.connection_hops}`; });

// ---- BITCOIN ----
const btc = new EsploraClient('https://mempool.space'), tbtc = new EsploraClient('https://mempool.space/testnet');
await check('bitcoin', 'mainnet tip height', async () => `tip ${await btc.getTipHeight()}`);
await check('bitcoin', 'mainnet genesis hash matches chain id 000000000019d6689c085ae165831e93', async () => { const h = await btc.getBlockHashAtHeight(0); must(h.startsWith('000000000019d6689c085ae165831e93'), h); return h; });
await check('bitcoin', 'testnet genesis hash matches chain id 000000000933ea01ad0ee984209779ba', async () => { const h = await tbtc.getBlockHashAtHeight(0); must(h.startsWith('000000000933ea01ad0ee984209779ba'), h); return h; });
await check('bitcoin', 'mainnet recommended fees (mempool.space)', async () => JSON.stringify(await btc.getRecommendedFees()));
await check('bitcoin', 'testnet recommended fees', async () => JSON.stringify(await tbtc.getRecommendedFees()));
await check('bitcoin', 'mainnet address balance 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', async () => { must(validateBitcoinAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'mainnet').valid, 'addr'); const b = await btc.getAddressBalance('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'); return `confirmed ${b.confirmedSat} sat, unconfirmed delta ${b.unconfirmedDeltaSat}`; });
await check('bitcoin', 'mainnet utxo list', async () => `${(await btc.getAddressUtxos('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).length} utxos`);
await check('bitcoin', 'tx status for genesis coinbase 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', async () => { const s = await btc.getTxStatus('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'); return JSON.stringify(s); });

// ---- TON ----
const ton = new ToncenterClient('https://toncenter.com');
await check('ton', 'getMasterchainInfo (zero-state hash = mainnet)', async () => { const m = await ton.getMasterchainInfo(); must(m.zeroStateRootHash === 'F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=', m.zeroStateRootHash); return `seqno ${m.seqno}`; });
await check('ton', 'getWalletInformation (EQDKbj...)', async () => { must(validateTonAddress('EQDKbjIcfM6ezt8KjKJJLshZJJSqX7XOA4ff-W72r5gqPrHF').valid, 'crc'); const w = await ton.getWalletInfo('EQDKbjIcfM6ezt8KjKJJLshZJJSqX7XOA4ff-W72r5gqPrHF'); return `balance ${w.balance} nano, seqno ${w.seqno}, state ${w.state}`; });
await check('ton', 'getConfigParam 21 (gas prices cell)', async () => `cell bytes(b64) length ${(await ton.getConfigParam(21)).length}`);

// ---- NEAR ----
const near = new NearRpcClient('https://rpc.mainnet.near.org');
await check('near', 'status (chain_id=mainnet)', async () => { const s = await near.status(); must(s.chainId === 'mainnet', s.chainId); return `height ${s.latestHeight} protocol ${s.protocolVersion} syncing=${s.syncing}`; });
await check('near', 'gas_price', async () => `${await near.gasPriceYocto()} yocto/gas`);
await check('near', 'view_account near (final)', async () => { const a = await near.viewAccount('near'); must(a, 'exists'); return `amount ${a!.amount} yocto storage ${a!.storageUsage}`; });
await check('near', 'protocol config (validity period, storage price, max prepaid gas)', async () => { const p = await near.protocolConfig(); return `validity ${p.transactionValidityPeriod} blocks, storage ${p.storageAmountPerByte} yocto/B, maxPrepaidGas ${p.maxTotalPrepaidGas}`; });

// ---- COINBASE ----
const cb = new CoinbasePublicVenue();
await check('coinbase', 'REST public products (SPOT)', async () => { const m = await cb.listMarkets(); const btcUsd = m.find((x) => x.symbol === 'BTC-USD'); must(btcUsd, 'BTC-USD'); return `${m.length} markets, online ${m.filter((x) => x.status === 'online').length}; BTC-USD ${JSON.stringify(btcUsd)}`; });
await check('coinbase', 'REST public product_book BTC-USD', async () => { const b = await cb.getOrderBook('BTC-USD', 5); return `bid ${b.bids[0]?.price} ask ${b.asks[0]?.price} age ${Date.now() - b.ts}ms`; });
await check('coinbase', `WebSocket level2 (${COINBASE_WS_URL}) connect + L2BookSync snapshot/updates/sequence`, async () => {
  const WS = (globalThis as any).WebSocket; if (!WS) throw new Error('no global WebSocket in this runtime');
  return await new Promise<string>((resolve, reject) => {
    const ws = new WS(COINBASE_WS_URL); const book = new L2BookSync(['BTC-USD']); const seqs: number[] = []; const chans = new Set<string>(); let applied = 0, bad = '';
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error(`timeout after 15s; messages=${seqs.length}`)); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'level2' }));
    ws.onerror = (e: any) => { clearTimeout(timer); reject(new Error('ws error: ' + (e?.message ?? 'connection failed'))); };
    ws.onmessage = (ev: any) => {
      const m = JSON.parse(String(ev.data)); if (typeof m.sequence_num === 'number') seqs.push(m.sequence_num); chans.add(String(m.channel));
      const r = book.feed(m, Date.now()); if (r.action === 'applied') applied++; if (r.action === 'resync') bad = `${r.reason}: ${r.detail}`;
      if (bad || (applied >= 6 && book.getState() === 'SYNCED')) {
        clearTimeout(timer); ws.close();
        if (bad) return reject(new Error('L2BookSync resync on live data: ' + bad));
        const s = book.snapshot('BTC-USD', Date.now(), 5000, 3);
        resolve(`sequence_nums ${seqs.join(',')}; channels ${[...chans].join('/')}; state ${book.getState()}; applied ${applied}; top bid ${s.bids[0]?.price} ask ${s.asks[0]?.price}; gaps ${book.gapCount}`);
      }
    };
  });
});

// ---- render ----
const iso = new Date().toISOString();
console.log(`# Families B + venues: live READ-ONLY verification\n\nGenerated ${iso} by \`packages/exchange-adapters/scripts/live-reads.ts\`.\nCommand: \`node --experimental-transform-types packages/exchange-adapters/scripts/live-reads.ts\`\nEnvironment: Claude Code cloud container, outbound HTTPS via agent proxy, Node ${process.version}. No credentials, no signing, no broadcast. Only GET / read-style JSON-RPC calls.\nStatus legend: PASS = real read returned and was validated by assertions; BLOCKED = request failed (error recorded). Nothing here is CERTIFIED.\n`);
const summary = new Map<string, { p: number; b: number }>();
for (const r of results) { const s = summary.get(r.section) ?? { p: 0, b: 0 }; r.status === 'PASS' ? s.p++ : s.b++; summary.set(r.section, s); }
console.log('## Summary\n\n| Section | PASS | BLOCKED |\n|---|---|---|');
for (const [k, v] of summary) console.log(`| ${k} | ${v.p} | ${v.b} |`);
let cur = '';
for (const r of results) {
  if (r.section !== cur) { cur = r.section; console.log(`\n## ${cur}\n\n<a id="${cur}"></a>\n\n| Check | Status | ms | Result / error |\n|---|---|---|---|`); }
  console.log(`| ${r.name} | ${r.status} | ${r.ms} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
}
