use apex_execution::economics::*;
use proptest::prelude::*;

fn base() -> EconomicsInput {
    EconomicsInput {
        notional: 100_000_000, // 100 USDC (6 decimals)
        expected_edge_bps: 200,
        entry_fee_bps: 25,
        exit_fee_bps: 25,
        entry_slippage_bps: 10,
        exit_slippage_bps: 10,
        gas_entry_quote: 50_000,
        gas_exit_quote: 50_000,
        failed_tx_prob_bps: 500,
        failed_tx_cost_quote: 30_000,
        tx_legs: 2,
        adverse_selection_bps: 10,
    }
}

#[test]
fn hand_computed_round_trip_example() {
    // gross 2_000_000; entry fee 250_000; exit fee 250_000; slippage 200_000; adverse 100_000; gas 100_000;
    // failed-tx: 5% * 30_000 * 2 legs = 3_000  => cost 903_000, net 1_097_000 = 109 bps (floor of 109.7)
    let e = compute(&base()).unwrap();
    assert_eq!(e.gross_edge, 2_000_000);
    assert_eq!(e.entry_fee, 250_000);
    assert_eq!(e.exit_fee, 250_000);
    assert_eq!(e.slippage, 200_000);
    assert_eq!(e.adverse_selection, 100_000);
    assert_eq!(e.gas, 100_000);
    assert_eq!(e.failed_tx_expected, 3_000);
    assert_eq!(e.total_cost, 903_000);
    assert_eq!(e.net_ev, 1_097_000);
    assert_eq!(e.net_ev_bps, 109);
    assert!(evaluate(&base(), &EconomicsConfig::default()).is_ok());
}

#[test]
fn unprofitable_quotes_are_rejected_with_reasons() {
    let mut i = base();
    i.expected_edge_bps = 90; // gross 900_000 < costs 903_000
    let (e, r) = evaluate(&i, &EconomicsConfig::default()).unwrap_err();
    assert_eq!(e.unwrap().net_ev, -3_000);
    assert!(r.iter().any(|x| matches!(x, EconomicsReject::NetEvNotPositive { net_ev: -3_000 })));
    assert!(r.iter().any(|x| matches!(x, EconomicsReject::BelowMinMargin { .. })));

    // gas dominates a tiny order even with a big percentage edge
    let mut i = base();
    i.notional = 10_000; // 0.01 USDC
    i.expected_edge_bps = 500;
    i.gas_entry_quote = 100_000;
    let (_, r) = evaluate(&i, &EconomicsConfig::default()).unwrap_err();
    assert!(r.iter().any(|x| matches!(x, EconomicsReject::NetEvNotPositive { .. })));

    // positive net EV but fees eat too much of the edge: rejected by the fee-share bar alone
    let mut i = base();
    i.expected_edge_bps = 140; // fees 50bps = 35.7% -> ok at 50%
    i.entry_slippage_bps = 0;
    i.exit_slippage_bps = 0;
    i.adverse_selection_bps = 0;
    assert!(evaluate(&i, &EconomicsConfig::default()).is_ok());
    let strict = EconomicsConfig { min_net_ev_bps: 1, max_fee_share_of_edge_bps: 3_000 };
    let (_, r) = evaluate(&i, &strict).unwrap_err();
    assert_eq!(r.len(), 1);
    assert!(matches!(r[0], EconomicsReject::FeeShareOfEdgeTooHigh { .. }));

    // non-positive edge and zero notional
    let mut i = base();
    i.expected_edge_bps = 0;
    assert!(evaluate(&i, &EconomicsConfig::default()).is_err());
    i.notional = 0;
    assert_eq!(compute(&i), Err(EconomicsReject::ZeroNotional));
    let mut i = base();
    i.notional = u128::MAX;
    assert_eq!(compute(&i), Err(EconomicsReject::Overflow));
}

#[test]
fn exit_fee_alone_can_flip_a_profitable_entry() {
    // gross edge covers entry cost but not entry+exit: this is why only the ROUND TRIP matters
    let mut i = base();
    i.gas_entry_quote = 0;
    i.gas_exit_quote = 0;
    i.failed_tx_prob_bps = 0;
    i.adverse_selection_bps = 0;
    i.expected_edge_bps = 60;
    i.exit_fee_bps = 0;
    i.exit_slippage_bps = 0;
    assert!(compute(&i).unwrap().net_ev > 0, "entry-only view looks profitable");
    i.exit_fee_bps = 25;
    i.exit_slippage_bps = 10;
    assert!(compute(&i).unwrap().net_ev < 0, "round trip is a loss");
}

fn arb() -> impl Strategy<Value = EconomicsInput> {
    (
        (1u128..1_000_000_000_000u128, -500i64..1500, 0u32..200, 0u32..200, 0u32..200, 0u32..200),
        (0u128..10_000_000, 0u128..10_000_000, 0u32..10_000, 0u128..10_000_000, 0u32..4, 0u32..200),
    )
        .prop_map(|((n, e, ef, xf, es, xs), (g1, g2, fp, fc, legs, adv))| EconomicsInput {
            notional: n,
            expected_edge_bps: e,
            entry_fee_bps: ef,
            exit_fee_bps: xf,
            entry_slippage_bps: es,
            exit_slippage_bps: xs,
            gas_entry_quote: g1,
            gas_exit_quote: g2,
            failed_tx_prob_bps: fp,
            failed_tx_cost_quote: fc,
            tx_legs: legs,
            adverse_selection_bps: adv,
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3000))]

    #[test]
    fn identity_and_conservative_rounding(i in arb()) {
        let e = compute(&i).unwrap();
        prop_assert_eq!(e.net_ev, e.gross_edge - e.total_cost);
        prop_assert_eq!(e.total_cost, e.entry_fee + e.exit_fee + e.slippage + e.gas + e.failed_tx_expected + e.adverse_selection);
        // exact (unrounded) net, scaled by 10_000, is an UPPER bound for ours: rounding never flatters the trade
        let bps_costs = (i.entry_fee_bps + i.exit_fee_bps + i.entry_slippage_bps + i.exit_slippage_bps + i.adverse_selection_bps) as i128;
        let exact_scaled = (i.notional as i128) * (i.expected_edge_bps as i128 - bps_costs)
            - 10_000 * (i.gas_entry_quote as i128 + i.gas_exit_quote as i128)
            - (i.failed_tx_prob_bps as i128) * (i.failed_tx_cost_quote as i128) * (i.tx_legs as i128);
        prop_assert!(e.net_ev * 10_000 <= exact_scaled);
        // and it is tight: at most one unit of rounding per cost component (6) + 1 for the edge floor
        prop_assert!(exact_scaled - e.net_ev * 10_000 <= 7 * 10_000);
    }

    #[test]
    fn raising_any_cost_never_raises_net_ev(i in arb(), which in 0usize..8, bump in 1u32..500) {
        let base_ev = compute(&i).unwrap().net_ev;
        let mut j = i.clone();
        match which {
            0 => j.entry_fee_bps += bump,
            1 => j.exit_fee_bps += bump,
            2 => j.entry_slippage_bps += bump,
            3 => j.exit_slippage_bps += bump,
            4 => j.gas_entry_quote += bump as u128,
            5 => j.gas_exit_quote += bump as u128,
            6 => j.adverse_selection_bps += bump,
            _ => j.failed_tx_cost_quote += bump as u128,
        }
        prop_assert!(compute(&j).unwrap().net_ev <= base_ev);
    }

    #[test]
    fn accepted_quotes_clear_every_bar(i in arb(), min in 0i64..100, share in 0u32..10_000) {
        let cfg = EconomicsConfig { min_net_ev_bps: min, max_fee_share_of_edge_bps: share };
        match evaluate(&i, &cfg) {
            Ok(e) => {
                prop_assert!(e.net_ev > 0);
                prop_assert!(e.net_ev_bps >= min as i128);
                prop_assert!(i.expected_edge_bps > 0);
                prop_assert!(((i.entry_fee_bps + i.exit_fee_bps) as i128) * 10_000 <= (i.expected_edge_bps as i128) * (share as i128));
            }
            Err((_, reasons)) => prop_assert!(!reasons.is_empty()),
        }
    }
}
