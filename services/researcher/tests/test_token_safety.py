from dataclasses import replace

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from researcher.tokensafety import StrategyAdmission, TokenFindings, VendorEvidence, admit, universal_gate

CLEAN_EVM = TokenFindings(
    "evm", sell_simulation_ok=True, sell_simulation_slippage_bps=120, buy_tax_bps=0, sell_tax_bps=0, owner_can_mint=False,
    is_upgradeable_proxy=False, ownership_renounced=True, can_pause_transfers=False, has_blacklist=False, can_change_tax=False,
    liquidity_usd=500_000, exit_depth_usd=300_000, lp_locked_pct=95, lp_lock_verified=True, lp_lock_remaining_days=365, lp_controlled_by_deployer=False,
    top1_holder_pct=4, top10_holder_pct=28, deployer_holder_pct=1, sybil_cluster_pct=5, age_hours=720, deployer_prior_rugs=0)
CLEAN_SOL = TokenFindings(
    "solana", sell_simulation_ok=True, sell_simulation_slippage_bps=100, buy_tax_bps=0, sell_tax_bps=0, mint_authority_set=False,
    freeze_authority_set=False, permanent_delegate_set=False, transfer_hook_set=False, transfer_fee_bps=0, liquidity_usd=400_000,
    exit_depth_usd=250_000, lp_locked_pct=100, lp_lock_verified=True, lp_lock_remaining_days=400, lp_controlled_by_deployer=False,
    top1_holder_pct=5, top10_holder_pct=30, deployer_holder_pct=0, sybil_cluster_pct=4, age_hours=500, deployer_prior_rugs=0)


def codes(d): return {v.code for v in d.vetoes}


def test_clean_tokens_pass_stage_one():
    for f in (CLEAN_EVM, CLEAN_SOL):
        d = universal_gate(f)
        assert d.passed and not d.vetoes and d.confidence == 1.0 and d.score > 90


def test_honeypot_rejected():
    d = universal_gate(replace(CLEAN_EVM, sell_simulation_ok=False, sell_tax_bps=9900))
    assert not d.passed and {"HONEYPOT_SELL_FAILS", "SELL_TAX_EXCESSIVE"} <= codes(d)


def test_buy_passes_but_sell_fails_is_not_saved_by_a_good_buy_test():
    """finding 27: passing a buy test must not matter if the sell path fails."""
    d = universal_gate(replace(CLEAN_EVM, buy_tax_bps=0, sell_simulation_ok=False, vendors=(VendorEvidence("goplus", 3.0),)))
    assert not d.passed and "HONEYPOT_SELL_FAILS" in codes(d)


def test_evm_mint_authority_rejected():
    assert "MINT_AUTHORITY" in codes(universal_gate(replace(CLEAN_EVM, owner_can_mint=True)))


def test_solana_mint_and_freeze_authority_rejected():
    d = universal_gate(replace(CLEAN_SOL, mint_authority_set=True, freeze_authority_set=True))
    assert not d.passed and {"MINT_AUTHORITY", "FREEZE_AUTHORITY"} <= codes(d)


def test_token2022_permanent_delegate_hook_and_fee_rejected():
    d = universal_gate(replace(CLEAN_SOL, permanent_delegate_set=True, transfer_hook_set=True, transfer_fee_bps=900))
    assert {"PERMANENT_DELEGATE", "TRANSFER_HOOK", "TRANSFER_FEE"} <= codes(d)


def test_upgradeable_proxy_with_live_admin_rejected_but_renounced_proxy_is_not_a_veto_by_itself():
    assert "UPGRADEABLE_PROXY" in codes(universal_gate(replace(CLEAN_EVM, is_upgradeable_proxy=True, ownership_renounced=False)))
    assert "UPGRADEABLE_PROXY" not in codes(universal_gate(replace(CLEAN_EVM, is_upgradeable_proxy=True, ownership_renounced=True)))


def test_concentrated_holders_rejected():
    d = universal_gate(replace(CLEAN_EVM, top1_holder_pct=42, top10_holder_pct=91))
    assert not d.passed and {"HOLDER_CONCENTRATION_TOP1", "HOLDER_CONCENTRATION_TOP10"} <= codes(d)
    assert "SYBIL_CLUSTER" in codes(universal_gate(replace(CLEAN_EVM, sybil_cluster_pct=60)))


def test_fake_liquidity_lock_rejected():
    claimed_not_verified = universal_gate(replace(CLEAN_EVM, lp_locked_pct=100, lp_lock_verified=False))
    assert "FAKE_OR_UNVERIFIED_LP_LOCK" in codes(claimed_not_verified)
    short = universal_gate(replace(CLEAN_EVM, lp_lock_remaining_days=3))
    assert "LP_LOCK_TOO_SHORT" in codes(short)
    deployer = universal_gate(replace(CLEAN_EVM, lp_controlled_by_deployer=True))
    assert "LP_DEPLOYER_CONTROLLED" in codes(deployer)
    partial = universal_gate(replace(CLEAN_EVM, lp_locked_pct=40))
    assert "LP_LOCK_PARTIAL" in codes(partial)


def test_serial_rug_deployer_and_low_liquidity_rejected():
    assert {"SERIAL_RUG_DEPLOYER", "LOW_LIQUIDITY"} <= codes(universal_gate(replace(CLEAN_EVM, deployer_prior_rugs=2, liquidity_usd=3_000)))


def test_unknown_critical_fields_fail_closed():
    d = universal_gate(replace(CLEAN_EVM, sell_simulation_ok=None, lp_lock_verified=None))
    assert not d.passed and "UNKNOWN_CRITICAL_FIELD" in codes(d) and d.confidence < 1.0
    assert not universal_gate(TokenFindings("evm")).passed


def test_stale_findings_rejected():
    assert "STALE_FINDINGS" in codes(universal_gate(replace(CLEAN_EVM, findings_age_seconds=5000)))


def test_vendor_scores_are_additive_evidence_only():
    great = universal_gate(replace(CLEAN_EVM, owner_can_mint=True, vendors=(VendorEvidence("goplus", 0.0), VendorEvidence("rugcheck", 1.0))))
    assert not great.passed                                                  # excellent vendor score cannot remove a native veto
    bad = universal_gate(replace(CLEAN_EVM, vendors=(VendorEvidence("rugcheck", 90.0, flags=("freeze",)),)))
    assert bad.passed and any(w.code == "VENDOR_FLAG" for w in bad.warnings)    # bad vendor score only adds evidence/warning
    assert bad.score < universal_gate(CLEAN_EVM).score
    stale = universal_gate(replace(CLEAN_EVM, vendors=(VendorEvidence("goplus", 99.0, age_seconds=99999),)))
    assert stale.passed and any("stale" in n for n in stale.vendor_notes)


def test_two_stage_admission():
    adm = StrategyAdmission("memetic_test", min_liquidity_usd=100_000, max_position_pct_of_exit_depth=2.0, min_net_edge_bps=50)
    ok = admit(CLEAN_EVM, adm, position_usd=3_000, expected_gross_edge_bps=300, est_slippage_bps=40)
    assert ok.admitted and ok.net_edge_bps == pytest.approx(220)
    too_big = admit(CLEAN_EVM, adm, position_usd=50_000, expected_gross_edge_bps=300, est_slippage_bps=40)
    assert not too_big.admitted and any("exit depth" in r for r in too_big.reasons)
    taxed = admit(replace(CLEAN_EVM, buy_tax_bps=300, sell_tax_bps=300), adm, 1000, 400, 20)
    assert not taxed.admitted and any("tax" in r for r in taxed.reasons)
    thin_edge = admit(CLEAN_EVM, adm, 1000, expected_gross_edge_bps=80, est_slippage_bps=30)
    assert not thin_edge.admitted and any("net edge" in r for r in thin_edge.reasons)
    scam = admit(replace(CLEAN_EVM, owner_can_mint=True), adm, 100, 10_000, 1)
    assert not scam.admitted and scam.net_edge_bps is None and "stage1" in scam.reasons[0]     # stage 2 never runs on a gate reject


def test_deterministic():
    f = replace(CLEAN_EVM, top1_holder_pct=20, vendors=(VendorEvidence("x", 70.0),))
    assert universal_gate(f) == universal_gate(f)


@settings(max_examples=100, deadline=None)
@given(st.sampled_from(["owner_can_mint", "can_pause_transfers", "has_blacklist", "can_change_tax", "lp_controlled_by_deployer"]),
       st.floats(0, 100), st.lists(st.floats(0, 100), max_size=3))
def test_adding_a_hazard_never_turns_reject_into_pass_and_vendors_never_help(field, vscore, extra):
    base = CLEAN_EVM
    hazardous = replace(base, **{field: True}, vendors=tuple(VendorEvidence(f"v{i}", s) for i, s in enumerate(extra + [vscore])))
    assert not universal_gate(hazardous).passed
    assert universal_gate(base).passed
