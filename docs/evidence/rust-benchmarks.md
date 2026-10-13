# Rust benchmarks (measured, not estimated)

**This is not an HFT claim.** These are in-process micro-measurements of a pure risk function and a synthetic paper
matcher, plus a Postgres-backed pipeline on the same host over loopback. No wire-to-fill (network, venue, signer)
latency was measured because no venue connectivity exists in this build.

## Command (exact)
```
cd /home/user/Apex-Crypto-Trader
cargo test --release -p apex-execution --test bench -- --ignored --nocapture
```
Harness: `services/execution/tests/bench.rs` (std::time::Instant; no criterion). Run started 2026-10-13T19:53:03Z, finished 2026-10-13T19:55:06Z (includes release compile).

## Machine
- Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU (virtualised, shared with other concurrent work), 16093 MB RAM
- Linux 6.18.44-fc-v114 x86_64; rustc 1.97.0 (2d8144b78 2026-07-07); PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu
- Postgres on the same host (loopback), default config, fsync as configured on this VM. Dev profile NOT used: `--release` (opt-level 3, thin LTO).

## Raw output (final run, verbatim)
```
## RAW OUTPUT
build: release

| metric | samples | mean | p50 | p99 | p99.9 | max | unit |
|---|---|---|---|---|---|---|---|
| Instant::now()+elapsed() overhead (baseline) | 200000 | 21 | 19 | 28 | 33 | 45613 | ns |
| risk evaluate() per call (ADMIT path, includes timer overhead) | 500000 | 45 | 42 | 72 | 113 | 105451 | ns |
| risk evaluate() per call (VETO path, 3 reasons allocated) | 500000 | 63 | 60 | 79 | 170 | 52909 | ns |

risk evaluate() batch: 5000000 calls in 0.107s = 21.5 ns/call = 46.62 M checks/s (single thread, no per-call timer)
policy resolve (4 layers incl. clone): 754 ns/call

paper exchange step_market (synthetic event generation + matching + canonical log line + SHA-256): 2000000 events in 18.419s = 108584 events/s (9209 ns/event); log lines hashed: 2626604
Book::match_order + replenish (price-time, no log/hash): 3000000 aggressive orders, 8999960 trades in 0.944s = 3.18 M orders/s, 9.53 M trades/s

| metric | samples | mean | p50 | p99 | p99.9 | max | unit |
|---|---|---|---|---|---|---|---|
| PaperExchange::place_order IOC marketable (match + 1 fill + log/hash) | 100000 | 4393 | 3325 | 12229 | 46818 | 2118150 | ns |
| risk decision persisted: load_policy + evaluate + INSERT risk_decisions (loopback PG, 1 tx) | 500 | 1244 | 813 | 5787 | 11259 | 11259 | us |

sequential full pipeline (intent->risk->reserve->quote->submit(paper)->fill->settle): 300 intents in 14.11s = 21.3 intents/s
| drive() latency, one intent, sequential (loopback PG) | 300 | 44456 | 39821 | 121220 | 419159 | 419159 | us |

concurrent full pipeline (24 concurrent drivers, pool 48): 600 intents in 13.77s = 43.6 intents/s
ledger conservation after benchmark: OK
```
Units: ns for in-process rows, us (microseconds) for Postgres rows. "mean/p50/p99/p99.9/max" are over the listed samples.
The per-call rows include ~20 ns of timer overhead (first row is the measured baseline); the batch row has none.
Max values are dominated by scheduler preemption on a shared VM and should not be read as the function's worst case.

## Run-to-run variance (same command, three runs on this shared VM)
| metric | run 1 | run 2 | run 3 (above) |
|---|---|---|---|
| risk evaluate() batch ns/call | 23.5 | 39.1 | 21.5 |
| risk evaluate() ADMIT p50 / p99 (ns, with timer) | 43 / 76 | 43 / 60 | 42 / 72 |
| paper step_market events/s (with log formatting + SHA-256) | 120,363 | 97,210 | 108,584 |
| Book::match_order orders/s (no log) | 2.92 M | 2.21 M | 3.18 M |
| sequential full pipeline intents/s (loopback PG) | n/a (harness assertion aborted before this section) | 21.7 | 21.3 |
| concurrent (24 drivers) intents/s | n/a | 49.6 | 43.6 |

(In run 1 the Postgres section failed on a harness assertion - IOC orders legitimately CANCELLED their unfilled remainder after
the synthetic book was drained - and was fixed to advance venue time between intents; its in-process numbers are still valid.)

## Interpretation (what the numbers do and do not say)
- Risk check: about 20-45 ns per pure evaluation (about 40-45 M checks/s single thread). That is the policy arithmetic only. A
  persisted decision (load policy from Postgres + evaluate + INSERT `risk_decisions`) costs about 0.8 ms median / 5.8 ms p99 over loopback.
- Matcher: the bare book does roughly 2-3 M aggressive orders/s (6-9 M trades/s). The paper exchange as used by the tests spends most of
  its time formatting and SHA-256-hashing the canonical event log: about 100 k market events/s.
- Pipeline: a full intent (a dozen-plus sequential Postgres transactions: each state transition, risk, reservation, fill, settlement, plus
  an advisory lock round trip; exact count not instrumented) takes about 40-42 ms median (p99 about 120 ms) on loopback, 21 intents/s sequentially and about 44-50 intents/s with 24 concurrent drivers.
  The bottleneck is Postgres commit latency and round trips, not Rust. Contention on one bucket's ledger rows serialises capital movement
  by design (that is the correctness mechanism). This is a safe-and-correct paper pipeline, not a low-latency trading path.
- No claim is made about real venue latency, fill rates, queue position accuracy or profitability.
