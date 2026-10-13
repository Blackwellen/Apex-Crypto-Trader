# Families B + venues: test evidence

Environment: Node v22.22.0, pnpm 10.28.0, TypeScript 5.8 (strict), runner `node:test` with `--experimental-transform-types`. Date 2026-10-13. Branch `claude/apex-build`. No commit made by this agent (working tree only; evidence SHA = the lead's commit of these paths). Network is not used by unit tests (all transports are injected fixtures); live reads are in `chains-b-live-reads.md`.

## Commands (run from repo root; each package: `pnpm test` = `node --test --experimental-transform-types src/*.test.ts`, `pnpm typecheck` = `tsc --noEmit -p .`)

```
pnpm install
pnpm --filter @apex/chain-tron test        && pnpm --filter @apex/chain-tron typecheck
pnpm --filter @apex/chain-cosmos test      && pnpm --filter @apex/chain-cosmos typecheck
pnpm --filter @apex/chain-bitcoin test     && pnpm --filter @apex/chain-bitcoin typecheck
pnpm --filter @apex/chain-ton test         && pnpm --filter @apex/chain-ton typecheck
pnpm --filter @apex/chain-near test        && pnpm --filter @apex/chain-near typecheck
pnpm --filter @apex/exchange-adapters test && pnpm --filter @apex/exchange-adapters typecheck
pnpm --filter @apex/contracts typecheck
node --experimental-transform-types packages/exchange-adapters/scripts/live-reads.ts > docs/evidence/chains-b-live-reads.md
```

## Results (final run)

| Package | Tests | Pass | Fail | Skipped | `tsc --noEmit` errors |
|---|---|---|---|---|---|
| @apex/chain-tron | 12 | 12 | 0 | 0 | 0 |
| @apex/chain-cosmos | 12 | 12 | 0 | 0 | 0 |
| @apex/chain-bitcoin | 16 | 16 | 0 | 0 | 0 |
| @apex/chain-ton | 8 | 8 | 0 | 0 | 0 |
| @apex/chain-near | 6 | 6 | 0 | 0 | 0 |
| @apex/exchange-adapters | 16 | 16 | 0 | 0 | 0 |
| @apex/contracts (typecheck only, additive export `chain-verification.ts`) | n/a | n/a | n/a | n/a | 0 |
| **Total** | **70** | **70** | **0** | **0** | **0** |

Note: a "test" is a `node:test` case; several contain many assertions (e.g. the Bitcoin property test runs 5000 random selections, the L2 gap property test 300 random streams, BIP173/350 vector tests ~30 addresses).

## What the tests prove (spec cross-reference)

- TRON (QA "Energy/Bandwidth exhaustion"): base58check with 0x41 + sha256d (all-zero address `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, bad-checksum, wrong-prefix, EVM-0x and BTC addresses rejected); chain parameters parsed from a `getchainparameters` fixture shape (zero values omitted) and **changing `getEnergyFee` changes the burn** (nothing hardcoded); free vs staked vs burned bandwidth; staged energy burn; fee_limit clamping and refusal when clamped below the need; native/TRC10/contract classification; reserve; fail-closed adapter.
- Cosmos (QA "IBC acknowledgement/timeouts"): official bech32 vectors; prefix validation/conversion; **IBC denom hash `ibc/27394FB0...5EB2` = sha256("transfer/channel-0/uatom")** (documented ATOM-on-Osmosis example) and `ibc/E6931F78...` (CRO, also confirmed against the live Osmosis LCD); spoofed traces rejected; fee ceil maths; sequence reservation/mismatch resync; lifecycle SENT->RECEIVED->ACK(success|error) or SENT->TIMED_OUT, RECEIVED->TIMED_OUT illegal, dispatch never final, duplicate/lost/contradictory relayer events; timeout by height/timestamp; channel validation.
- Bitcoin (QA "UTXO selection, insufficient fees, RBF and unconfirmed inputs"): BIP173 + BIP350 valid/invalid vectors incl. wrong variant for witness version; network mismatch; vsize known values (1-in-2-out P2WPKH = 141 vB, legacy = 226); BnB exact-match without change; dust; fee caps; negative-effective-value inputs; BIP125 rules 1-5; CPFP; depth finality and reorg detection. **Property test (5000 seeded random cases): inputs always cover outputs+fee (exact conservation), fee never exceeds the absolute or rate cap, fee >= required, change >= dust, no duplicate inputs, no unconfirmed external input ever selected.**
- TON: CRC16 check value 0x31C3; friendly/raw round trip against toncenter-confirmed vectors (`EQDKbj...` / `UQDKbj...`); corrupted/foreign rejected; seqno + valid_until window; re-sign only after expiry with unchanged seqno; unknown seqno is `null` (never 0).
- NEAR: account-id valid/invalid sets, implicit/ETH-implicit kinds, sub-account creation rule; TGas/yocto maths; prepaid-gas and storage-stake checks; nonce manager incl. `InvalidNonce` resync; finality classification (only FINAL is final).
- Exchange adapters (QA "CEX stream gap, disconnect/reconnect, rate limit 429 backoff, partial fills and unknown order"): Coinbase public adapter only ever calls `/market/` URLs and has **no `placeOrder`**; non-trading states map to `offline`; `L2BookSync` gap/duplicate/regression/crossed/update-before-snapshot/malformed/stale handling plus a 300-stream random-drop property test (every drop detected, book withheld); rate limiter with fake clock (exact backoff series 100/200/400/800/1000, Retry-After floor, jitter bounds, budget wait, cooldown, non-retryable calls never retried, exhaustion error); **UNKNOWN reconciler: timeout after venue accepted -> found by client_order_id, `createOrder` called exactly once; timeout before accept -> UNRESOLVED, still never resubmitted; duplicate client id refused**; credential scope validator (withdraw/transfer/margin/futures/unknown/nested/missing all rejected; Binance- and Coinbase-style inputs) and redaction; paper venue determinism, SYNTHETIC labels, idempotency, fees, funds-limited partial fills; all venue records `UNVERIFIED` UK availability.

## Failures encountered during development (all fixed, none hidden)

1. `@apex/chain-near` gas-fee test: my expected constant was off by 1000x (30 TGas x 1e8 yocto = 3e21, not 3e18). Test corrected, code unchanged.
2. `@apex/chain-bitcoin` selection test: chosen input (10,500 sat) legitimately left a change output above dust (390 > 294), so "absorbed into fee" expectation was wrong. Test inputs changed to 10,300 sat; code unchanged.
3. `@apex/exchange-adapters` paper test: a 1000 BTC market buy with 100k USD is correctly a funds-limited partial fill, not a rejection. Assertion corrected to `partially_filled` and balance non-negative.
4. Type error in a test transport literal (`headers` optional) fixed by annotating the return type.
5. Design fix before first run: `enableSpotAndMarginTrading` (Binance) was matched by the TRADE allow-list; it now falls under forbidden `margin` (spot-only policy), covered by a test.

## Known gaps (not tested / not done)

- No test exercises real signing, broadcasting, or any testnet transaction on any chain (none exists). TRON energy estimates are caller-supplied; no `triggerconstantcontract` simulation is wired.
- IBC lifecycle is verified against synthetic events only; no relayer/event-stream ingestion.
- Bitcoin vsize table covers single-sig input types only (no multisig/script-path P2TR/P2WSH inputs); varint counts >= 253 rejected explicitly.
- TON jettons, NEAR NEP-141, Cosmos CW20/Osmosis pools, TRC20 balances: not implemented.
- `ukAvailability` remains `UNVERIFIED` everywhere by design.
