use apex_risk::policy::PolicyError;
use apex_risk::*;
use proptest::prelude::*;
use std::collections::BTreeSet;

fn set(v: &[&str]) -> BTreeSet<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn base_input() -> RiskInput {
    RiskInput {
        side: Side::Buy,
        asset_key: "ETH".into(),
        notional: 1_000,
        bucket_value: 100_000,
        slippage_bps: 10,
        quote_age_ms: 100,
        data_health: DataHealth::Healthy,
        total_fee_bps: 20,
        expected_edge_bps: 100,
        post_trade_concentration_bps: 500,
        failed_tx_rate_bps: 0,
        open_unknown_orders: 0,
        global_state: GlobalState::Active,
        bucket_active: true,
        reduces_exposure: false,
    }
}

fn codes(d: &Decision) -> Vec<String> {
    match d {
        Decision::Veto(r) => r.iter().map(|x| serde_json::to_value(x).unwrap()["code"].as_str().unwrap().to_string()).collect(),
        _ => vec![],
    }
}

#[test]
fn healthy_entry_admitted() {
    assert_eq!(evaluate(&Policy::conservative_defaults(), &base_input()), Decision::Admit { exit_path: false });
}

#[test]
fn each_entry_check_vetoes() {
    let p = Policy::conservative_defaults();
    let cases: Vec<(&str, Box<dyn Fn(&mut RiskInput)>)> = vec![
        ("QuoteStale", Box::new(|i| i.quote_age_ms = 2_001)),
        ("SlippageTooHigh", Box::new(|i| i.slippage_bps = 101)),
        ("OrderTooLarge", Box::new(|i| i.notional = 25_001)),
        ("BucketEmpty", Box::new(|i| i.bucket_value = 0)),
        ("FeeCeilingExceeded", Box::new(|i| i.total_fee_bps = 51)), // 51/100 > 50%
        ("NoPositiveEdge", Box::new(|i| i.expected_edge_bps = 0)),
        ("ConcentrationExceeded", Box::new(|i| i.post_trade_concentration_bps = 3_001)),
        ("FailedTxRateTooHigh", Box::new(|i| i.failed_tx_rate_bps = 1_001)),
        ("UnknownOrdersOpen", Box::new(|i| i.open_unknown_orders = 1)),
        ("DataDegraded", Box::new(|i| i.data_health = DataHealth::Degraded)),
        ("GlobalStateBlocksEntries", Box::new(|i| i.global_state = GlobalState::HaltNewEntries)),
        ("BucketNotActive", Box::new(|i| i.bucket_active = false)),
    ];
    for (code, mutate) in cases {
        let mut i = base_input();
        mutate(&mut i);
        let d = evaluate(&p, &i);
        assert!(!d.is_admit(), "{code} should veto");
        assert!(codes(&d).iter().any(|c| c == code), "{code} missing in {:?}", codes(&d));
    }
    // boundary values are admitted
    let mut i = base_input();
    i.quote_age_ms = 2_000;
    i.slippage_bps = 100;
    i.notional = 25_000;
    i.total_fee_bps = 50;
    assert!(evaluate(&p, &i).is_admit());
}

#[test]
fn blacklist_and_allowlist() {
    let p = Policy::conservative_defaults().tighten(&PolicyLayer { blacklist: Some(set(&["ETH"])), ..Default::default() });
    assert!(codes(&evaluate(&p, &base_input())).contains(&"AssetBlacklisted".to_string()));
    let p = Policy::conservative_defaults().tighten(&PolicyLayer { allowlist: Some(set(&["BTC"])), ..Default::default() });
    assert!(codes(&evaluate(&p, &base_input())).contains(&"AssetNotAllowlisted".to_string()));
}

#[test]
fn stale_quote_denied_for_exits_too() {
    let mut i = base_input();
    i.side = Side::Sell;
    i.reduces_exposure = true;
    i.quote_age_ms = 10_000;
    assert!(!evaluate(&Policy::conservative_defaults(), &i).is_admit());
}

#[test]
fn degraded_data_denies_entries_allows_exits() {
    let p = Policy::conservative_defaults();
    let mut i = base_input();
    i.data_health = DataHealth::Degraded;
    assert!(!evaluate(&p, &i).is_admit());
    i.side = Side::Sell;
    i.reduces_exposure = true;
    assert_eq!(evaluate(&p, &i), Decision::Admit { exit_path: true });
}

#[test]
fn every_global_state_blocks_entries_but_allows_exits() {
    let p = Policy::conservative_defaults();
    for gs in [GlobalState::HaltNewEntries, GlobalState::ExitOnly, GlobalState::EmergencyStopped] {
        let mut i = base_input();
        i.global_state = gs;
        assert!(!evaluate(&p, &i).is_admit(), "{gs:?} must block entries");
        // a BUY is never an exit even if the caller (wrongly) claims it reduces exposure
        i.reduces_exposure = true;
        assert!(!evaluate(&p, &i).is_admit(), "{gs:?}: a buy cannot masquerade as an exit");
        i.side = Side::Sell;
        assert_eq!(evaluate(&p, &i), Decision::Admit { exit_path: true }, "{gs:?} must allow exits");
        // a sell that does NOT reduce exposure (i.e. opens a short / spends unowned inventory) is an entry
        i.reduces_exposure = false;
        assert!(!evaluate(&p, &i).is_admit());
    }
}

#[test]
fn unknown_global_state_string_fails_closed() {
    assert_eq!(GlobalState::parse("something_new"), GlobalState::EmergencyStopped);
}

#[test]
fn policy_json_rejects_garbage_and_missing_keys_fall_back_to_conservative() {
    assert_eq!(Policy::global_from_json(&serde_json::json!({})).unwrap(), Policy::conservative_defaults());
    assert!(matches!(PolicyLayer::from_json(&serde_json::json!({"max_slippage_bps": "abc"})), Err(PolicyError::BadValue(_))));
    assert!(matches!(PolicyLayer::from_json(&serde_json::json!({"max_slippage_bps": -5})), Err(PolicyError::BadValue(_))));
    assert!(matches!(PolicyLayer::from_json(&serde_json::json!([1])), Err(PolicyError::NotObject)));
    let p = Policy::global_from_json(&serde_json::json!({"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000})).unwrap();
    assert_eq!(p.max_slippage_bps, 100);
}

#[test]
fn child_cannot_loosen_parent_concrete() {
    let parent = Policy::conservative_defaults();
    let loose = PolicyLayer {
        max_slippage_bps: Some(10_000),
        max_order_notional_bps_of_bucket: Some(10_000),
        max_quote_age_ms: Some(1_000_000),
        entries_enabled: Some(true),
        max_open_unknown_orders: Some(50),
        ..Default::default()
    };
    let merged = parent.tighten(&loose);
    assert_eq!(merged, parent);
}

#[test]
fn disabled_entries_cannot_be_reenabled_by_child() {
    let off = Policy::conservative_defaults().tighten(&PolicyLayer { entries_enabled: Some(false), ..Default::default() });
    let child = off.tighten(&PolicyLayer { entries_enabled: Some(true), ..Default::default() });
    assert!(!child.entries_enabled);
    assert!(!evaluate(&child, &base_input()).is_admit());
}

// ---------------------------------------------------------------- property tests

fn arb_set() -> impl Strategy<Value = BTreeSet<String>> {
    proptest::collection::btree_set(prop::sample::select(vec!["BTC", "ETH", "SOL", "DOGE", "PEPE"]).prop_map(String::from), 0..5)
}
fn arb_layer() -> impl Strategy<Value = PolicyLayer> {
    (
        proptest::option::of(0u32..20_000),
        proptest::option::of(0u32..20_000),
        proptest::option::of(0u64..100_000),
        proptest::option::of(0u32..20_000),
        proptest::option::of(0u32..20_000),
        proptest::option::of(0u32..20_000),
        proptest::option::of(0u32..100),
        proptest::option::of(any::<bool>()),
        proptest::option::of(arb_set()),
        proptest::option::of(arb_set()),
    )
        .prop_map(|(a, b, c, d, e, f, g, h, i, j)| PolicyLayer {
            max_order_notional_bps_of_bucket: a,
            max_slippage_bps: b,
            max_quote_age_ms: c,
            max_fee_to_edge_bps: d,
            max_concentration_bps: e,
            max_failed_tx_rate_bps: f,
            max_open_unknown_orders: g,
            entries_enabled: h,
            blacklist: i,
            allowlist: j,
        })
}
fn arb_policy() -> impl Strategy<Value = Policy> {
    arb_layer().prop_map(|l| Policy::global_from_json(&serde_json::to_value(&l).unwrap()).unwrap())
}
fn arb_level() -> impl Strategy<Value = Level> {
    prop::sample::select(vec![Level::Global, Level::Portfolio, Level::Bucket, Level::Wallet, Level::Basket, Level::Strategy, Level::Order])
}
fn arb_input() -> impl Strategy<Value = RiskInput> {
    (
        (
            any::<bool>(),
            prop::sample::select(vec!["BTC", "ETH", "SOL", "DOGE", "PEPE"]),
            1u128..10_000_000,
            0u128..100_000_000,
            0u32..300,
            0u64..5_000,
            any::<bool>(),
        ),
        (
            0u32..200,
            -50i64..500,
            0u32..10_000,
            0u32..3_000,
            0u32..3,
            prop::sample::select(vec![GlobalState::Active, GlobalState::HaltNewEntries, GlobalState::ExitOnly, GlobalState::EmergencyStopped]),
            any::<bool>(),
            any::<bool>(),
        ),
    )
        .prop_map(|((buy, a, n, bv, sl, qa, dh), (fee, edge, conc, ftx, unk, gs, ba, red))| RiskInput {
            side: if buy { Side::Buy } else { Side::Sell },
            asset_key: a.into(),
            notional: n,
            bucket_value: bv,
            slippage_bps: sl,
            quote_age_ms: qa,
            data_health: if dh { DataHealth::Healthy } else { DataHealth::Degraded },
            total_fee_bps: fee,
            expected_edge_bps: edge,
            post_trade_concentration_bps: conc,
            failed_tx_rate_bps: ftx,
            open_unknown_orders: unk,
            global_state: gs,
            bucket_active: ba,
            reduces_exposure: red,
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// merged policy is never looser than the parent (nor than the child layer applied alone to the same parent).
    #[test]
    fn merged_never_looser_than_parent(parent in arb_policy(), layer in arb_layer()) {
        let merged = parent.tighten(&layer);
        prop_assert!(merged.is_at_most_as_loose_as(&parent));
        // idempotent: applying the same layer twice changes nothing
        prop_assert_eq!(merged.tighten(&layer), merged.clone());
    }

    /// Any chain of layers, in any hierarchy level order, is never looser than the root, and each prefix is
    /// at most as loose as the previous one (monotone tightening down the hierarchy).
    #[test]
    fn hierarchy_monotone(root in arb_policy(), layers in proptest::collection::vec((arb_level(), arb_layer()), 0..8)) {
        let resolved = Policy::resolve(&root, &layers);
        prop_assert!(resolved.is_at_most_as_loose_as(&root));
        let mut sorted = layers.clone();
        sorted.sort_by_key(|(l, _)| *l);
        let mut cur = root.clone();
        for (_, l) in &sorted {
            let next = cur.tighten(l);
            prop_assert!(next.is_at_most_as_loose_as(&cur));
            cur = next;
        }
        prop_assert_eq!(cur, resolved);
    }

    /// The order in which layers are applied does not matter (so no level can win by position).
    #[test]
    fn tighten_commutes(root in arb_policy(), a in arb_layer(), b in arb_layer()) {
        prop_assert_eq!(root.tighten(&a).tighten(&b), root.tighten(&b).tighten(&a));
    }

    /// Soundness of the gate under tightening: if the LOOSER policy vetoes an input, the tighter one vetoes it too
    /// (a child layer can never turn a veto into an admit).
    #[test]
    fn tighter_policy_never_admits_what_parent_vetoes(parent in arb_policy(), layer in arb_layer(), input in arb_input()) {
        let merged = parent.tighten(&layer);
        if !evaluate(&parent, &input).is_admit() {
            prop_assert!(!evaluate(&merged, &input).is_admit());
        }
    }

    /// Entries never pass while global state is not Active; for entries (non-exit) it holds for every input.
    #[test]
    fn halted_state_never_admits_entry(p in arb_policy(), mut input in arb_input()) {
        input.reduces_exposure = false;
        if input.global_state != GlobalState::Active {
            prop_assert!(!evaluate(&p, &input).is_admit());
        }
    }

    /// Stale quotes are never admitted, whatever else is true.
    #[test]
    fn stale_never_admitted(p in arb_policy(), mut input in arb_input()) {
        input.quote_age_ms = p.max_quote_age_ms.saturating_add(1);
        prop_assert!(!evaluate(&p, &input).is_admit());
    }

    /// Degraded data never admits an entry.
    #[test]
    fn degraded_never_admits_entry(p in arb_policy(), mut input in arb_input()) {
        input.reduces_exposure = false;
        input.data_health = DataHealth::Degraded;
        prop_assert!(!evaluate(&p, &input).is_admit());
    }

    /// A risk-reducing sell with fresh, sane pricing is always admitted regardless of halt/degradation state.
    #[test]
    fn exits_admitted_when_quote_fresh(p in arb_policy(), mut input in arb_input()) {
        input.side = Side::Sell;
        input.reduces_exposure = true;
        input.quote_age_ms = input.quote_age_ms.min(p.max_quote_age_ms);
        input.slippage_bps = input.slippage_bps.min(p.max_slippage_bps);
        prop_assert_eq!(evaluate(&p, &input), Decision::Admit { exit_path: true });
    }
}
