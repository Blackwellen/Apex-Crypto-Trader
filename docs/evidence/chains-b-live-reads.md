# Families B + venues: live READ-ONLY verification

Generated 2026-10-13T19:39:11.020Z by `packages/exchange-adapters/scripts/live-reads.ts`.
Command: `node --experimental-transform-types packages/exchange-adapters/scripts/live-reads.ts`
Environment: Claude Code cloud container, outbound HTTPS via agent proxy, Node v22.22.0. No credentials, no signing, no broadcast. Only GET / read-style JSON-RPC calls.
Status legend: PASS = real read returned and was validated by assertions; BLOCKED = request failed (error recorded). Nothing here is CERTIFIED.

## Summary

| Section | PASS | BLOCKED |
|---|---|---|
| tron | 10 | 0 |
| cosmos | 11 | 0 |
| bitcoin | 8 | 0 |
| ton | 3 | 0 |
| near | 4 | 0 |
| coinbase | 3 | 0 |

## tron

<a id="tron"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| mainnet getnowblock | PASS | 427 | height 87082461 id 000000000530c5dd... |
| mainnet genesis blockID matches chain id suffix 2b6653dc | PASS | 87 | blockID 00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc |
| nile genesis blockID matches chain id suffix cd8690dc | PASS | 200 | blockID 0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc |
| mainnet getchainparameters parsed by model | PASS | 76 | energyFee=100 sun, bandwidthFee=1000 sun/B, maxFeeLimit=15000000000 sun, freeNet=600, dynamicEnergy=true, params=80 |
| nile getnowblock + getchainparameters | PASS | 138 | height 71796358, energyFee=100, bandwidthFee=1000 |
| mainnet getaccount (USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t) | PASS | 121 | exists=true balanceSun=1091793521786 |
| mainnet getaccountresource | PASS | 76 | freeNetLimit=600 netLimit=0 energyLimit=0 |
| solidified block (finality) via /walletsolidity | PASS | 123 | solidified 87082445, head 87082464, lag 19 blocks |
| gettransactioninfobyid for a tx from a recent block | PASS | 2042 | tx f271efbcbab4... block 87082425 result SUCCESS net 282 energy 0 fee 0 |
| witness address from live block round-trips base58check | PASS | 62 | 4167e39013be3cdd3814bed152d7439fb5b6791409 -> TKSXDA8HfE9E1y39RczVQ1ZascUEtaSToF |

## cosmos

<a id="cosmos"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| Cosmos Hub node_info (network=cosmoshub-4) | PASS | 301 | cosmoshub-4 gaiad v28.3.0 |
| Osmosis node_info (network=osmosis-1) | PASS | 308 | osmosis-1 osmosisd 31.1.0 |
| Hub latest block | PASS | 123 | height 33394758 2026-10-13T19:38:10.817721513Z chain cosmoshub-4 |
| Hub node min gas prices (node-local, informational) | PASS | 53 | [{"amount":"0.005000000000000000","denom":"uatom"}] |
| Hub bank balances (fee collector module acct) | PASS | 97 | 0 denoms; first none |
| Hub auth account sequence | PASS | 65 | {"accountNumber":"25181","sequence":"0"} |
| Hub getTx for a tx hash derived from a recent block | PASS | 278 | tx AAD762784059... height 33394756 code 0 |
| Hub max memo chars (auth params) | PASS | 68 | max_memo_characters=512 |
| Osmosis IBC denom trace resolved AND hash-verified locally | PASS | 165 | path=transfer/channel-5 base=basecro hashVerified=true |
| Osmosis ATOM denom (documented example) trace | PASS | 65 | path=transfer/channel-0 base=uatom |
| Osmosis channel-0 (transfer) state/counterparty | PASS | 80 | state=STATE_OPEN counterparty=transfer/channel-141 hops=connection-1 |

## bitcoin

<a id="bitcoin"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| mainnet tip height | PASS | 231 | tip 971291 |
| mainnet genesis hash matches chain id 000000000019d6689c085ae165831e93 | PASS | 37 | 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f |
| testnet genesis hash matches chain id 000000000933ea01ad0ee984209779ba | PASS | 37 | 000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943 |
| mainnet recommended fees (mempool.space) | PASS | 39 | {"fastestFee":2,"halfHourFee":1,"hourFee":1,"economyFee":1,"minimumFee":1} |
| testnet recommended fees | PASS | 37 | {"fastestFee":1,"halfHourFee":1,"hourFee":1,"economyFee":1,"minimumFee":1} |
| mainnet address balance 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 | PASS | 39 | confirmed 0 sat, unconfirmed delta 0 |
| mainnet utxo list | PASS | 42 | 0 utxos |
| tx status for genesis coinbase 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b | PASS | 37 | {"confirmed":true,"blockHeight":0,"blockHash":"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"} |

## ton

<a id="ton"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| getMasterchainInfo (zero-state hash = mainnet) | PASS | 606 | seqno 98825729 |
| getWalletInformation (EQDKbj...) | PASS | 209 | balance 739477630155 nano, seqno 982, state active |
| getConfigParam 21 (gas prices cell) | PASS | 190 | cell bytes(b64) length 124 |

## near

<a id="near"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| status (chain_id=mainnet) | PASS | 3291 | height 219859655 protocol 86 syncing=false |
| gas_price | PASS | 3073 | 100000000 yocto/gas |
| view_account near (final) | PASS | 3069 | amount 69273164288951184568268221638 yocto storage 2263199 |
| protocol config (validity period, storage price, max prepaid gas) | PASS | 3070 | validity 86400 blocks, storage 10000000000000000000 yocto/B, maxPrepaidGas 1000000000000000 |

## coinbase

<a id="coinbase"></a>

| Check | Status | ms | Result / error |
|---|---|---|---|
| REST public products (SPOT) | PASS | 320 | 925 markets, online 879; BTC-USD {"symbol":"BTC-USD","base":"BTC","quote":"USD","tickSize":"0.01","lotSize":"0.00000001","minNotional":"1","status":"online"} |
| REST public product_book BTC-USD | PASS | 60 | bid 83136.7 ask 83136.71 age 491ms |
| WebSocket level2 (wss://advanced-trade-ws.coinbase.com) connect + L2BookSync snapshot/updates/sequence | PASS | 1827 | sequence_nums 0,1,2,3,4,5,6; channels l2_data/subscriptions; state SYNCED; applied 6; top bid 83136.7 ask 83136.71; gaps 0 |

## Run history and honesty notes

- Earlier runs of this same script in the same session recorded transient BLOCKED results that cleared on retry or a later run: TronGrid `HTTP 429` on `/walletsolidity/getnowblock` (unauthenticated rate limit; the script now paces calls 1.3 s apart), mempool.space testnet `HTTP 503` on `/api/v1/fees/recommended`, toncenter `HTTP 429` on `getConfigParam`, and a Cosmos Hub sample block that happened to contain no txs. These show the public endpoints are rate limited and must go through `RateLimitManager`; they are not failures of the adapters.
- `near.lava.build` returned HTTP 410 ("endpoint has been discontinued"); it is not listed as an RPC candidate. `rpc.mainnet.near.org` PASSED but took ~3 s per call.
- Only public third-party endpoints were used (TronGrid, publicnode LCD, mempool.space, toncenter, rpc.mainnet.near.org, api.coinbase.com). Their data is untrusted; chain identity was checked independently (genesis hashes / network names / zero-state hash above).
- READ_ONLY in the chain records is granted only to capabilities with a PASS row above. Nothing is CERTIFIED. TON/NEAR execution is UNSUPPORTED (documented blocker in the records); TRON/Cosmos/Bitcoin `submit` is PENDING (no broadcast code exists).
