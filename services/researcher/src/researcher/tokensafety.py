"""Rule-based, deterministic, vetoable token-safety scoring (spec section 6).

Two stages:
  1. UNIVERSAL SECURITY GATE: hard vetoes from native structured findings. Any veto => rejected, whatever the score.
     Unknown critical fields FAIL CLOSED (unknown is not safe).
  2. STRATEGY ADMISSION: per-strategy quantitative limits (liquidity, position vs exit depth, taxes, net edge).
Vendor scores (GoPlus/RugCheck/DEX Screener...) are ADDITIVE EVIDENCE ONLY: they can add warnings and lower the
informational score, never remove a veto, never make a token pass. Score is informational; vetoes decide.
Inputs are structured findings produced elsewhere (simulation, RPC reads); this module does no I/O.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Mapping


class Severity(str, Enum):
    VETO = "veto"
    WARN = "warn"


@dataclass(frozen=True)
class VendorEvidence:
    vendor: str
    risk_score: float | None            # vendor-defined, 0 (safe) .. 100 (risky); None if unavailable
    age_seconds: float = 0.0
    flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class TokenFindings:
    chain_family: Literal["evm", "solana"]
    # --- sell path (most important: finding 27) ---
    sell_simulation_ok: bool | None = None            # representative-size SELL simulated successfully
    sell_simulation_slippage_bps: float | None = None
    buy_tax_bps: float | None = None
    sell_tax_bps: float | None = None
    # --- EVM contract controls ---
    owner_can_mint: bool | None = None
    is_upgradeable_proxy: bool | None = None
    ownership_renounced: bool | None = None
    can_pause_transfers: bool | None = None
    has_blacklist: bool | None = None
    can_change_tax: bool | None = None
    # --- Solana / Token-2022 controls ---
    mint_authority_set: bool | None = None
    freeze_authority_set: bool | None = None
    permanent_delegate_set: bool | None = None
    transfer_hook_set: bool | None = None
    transfer_fee_bps: float | None = None
    # --- liquidity ---
    liquidity_usd: float | None = None
    exit_depth_usd: float | None = None               # effective depth at representative exit size
    lp_locked_pct: float | None = None                # claimed
    lp_lock_verified: bool | None = None              # verified on-chain by us (locker contract/program read)
    lp_lock_remaining_days: float | None = None
    lp_controlled_by_deployer: bool | None = None
    # --- holders ---
    top1_holder_pct: float | None = None              # excluding burn/LP/known CEX
    top10_holder_pct: float | None = None
    deployer_holder_pct: float | None = None
    sybil_cluster_pct: float | None = None            # supply held by wallets funded from a common source
    # --- history ---
    age_hours: float | None = None
    deployer_prior_rugs: int | None = None
    findings_age_seconds: float = 0.0
    vendors: tuple[VendorEvidence, ...] = ()


@dataclass(frozen=True)
class Finding:
    code: str
    severity: Severity
    detail: str


@dataclass(frozen=True)
class GateThresholds:
    max_sell_tax_bps: float = 1000.0
    max_buy_tax_bps: float = 1000.0
    max_sell_sim_slippage_bps: float = 1500.0
    max_top1_holder_pct: float = 15.0
    max_top10_holder_pct: float = 50.0
    max_deployer_holder_pct: float = 10.0
    max_sybil_cluster_pct: float = 25.0
    min_lp_lock_days: float = 90.0
    min_liquidity_usd: float = 25_000.0
    max_findings_age_seconds: float = 900.0
    vendor_max_age_seconds: float = 3600.0
    max_token2022_transfer_fee_bps: float = 300.0


@dataclass(frozen=True)
class GateDecision:
    passed: bool
    vetoes: tuple[Finding, ...]
    warnings: tuple[Finding, ...]
    score: float                  # informational 0..100 (higher = safer). NOT used to override vetoes
    confidence: float             # share of critical fields actually known
    vendor_notes: tuple[str, ...]
    explanation: str = ""


_CRITICAL_COMMON = ("sell_simulation_ok", "sell_tax_bps", "buy_tax_bps", "liquidity_usd", "exit_depth_usd", "top1_holder_pct",
                    "top10_holder_pct", "lp_lock_verified", "lp_controlled_by_deployer")
_CRITICAL_EVM = ("owner_can_mint", "is_upgradeable_proxy", "can_pause_transfers", "has_blacklist", "can_change_tax", "ownership_renounced")
_CRITICAL_SOL = ("mint_authority_set", "freeze_authority_set", "permanent_delegate_set", "transfer_hook_set")


def critical_fields(f: TokenFindings) -> tuple[str, ...]:
    return _CRITICAL_COMMON + (_CRITICAL_EVM if f.chain_family == "evm" else _CRITICAL_SOL)


def universal_gate(f: TokenFindings, th: GateThresholds | None = None) -> GateDecision:
    th = th or GateThresholds()
    V: list[Finding] = []
    W: list[Finding] = []
    veto = lambda c, d: V.append(Finding(c, Severity.VETO, d))  # noqa: E731
    warn = lambda c, d: W.append(Finding(c, Severity.WARN, d))  # noqa: E731

    # fail closed on unknowns
    crit = critical_fields(f)
    unknown = [n for n in crit if getattr(f, n) is None]
    for n in unknown:
        veto("UNKNOWN_CRITICAL_FIELD", f"{n} is unknown; unknown is treated as unsafe")
    if f.findings_age_seconds > th.max_findings_age_seconds:
        veto("STALE_FINDINGS", f"findings are {f.findings_age_seconds:.0f}s old (> {th.max_findings_age_seconds:.0f}s)")

    # sell path
    if f.sell_simulation_ok is False:
        veto("HONEYPOT_SELL_FAILS", "representative sell simulation failed or reverted")
    if f.sell_simulation_slippage_bps is not None and f.sell_simulation_slippage_bps > th.max_sell_sim_slippage_bps:
        veto("SELL_SIM_SLIPPAGE", f"simulated sell slippage {f.sell_simulation_slippage_bps} bps")
    if f.sell_tax_bps is not None and f.sell_tax_bps > th.max_sell_tax_bps:
        veto("SELL_TAX_EXCESSIVE", f"sell tax {f.sell_tax_bps} bps")
    if f.buy_tax_bps is not None and f.buy_tax_bps > th.max_buy_tax_bps:
        veto("BUY_TAX_EXCESSIVE", f"buy tax {f.buy_tax_bps} bps")

    # control surface
    if f.chain_family == "evm":
        if f.owner_can_mint:
            veto("MINT_AUTHORITY", "owner/privileged account can mint")
        if f.is_upgradeable_proxy and not f.ownership_renounced:
            veto("UPGRADEABLE_PROXY", "upgradeable proxy with live admin")
        if f.can_pause_transfers:
            veto("TRANSFER_PAUSABLE", "transfers can be paused")
        if f.has_blacklist:
            veto("BLACKLIST", "address blacklist/sell restriction function present")
        if f.can_change_tax:
            veto("MUTABLE_TAX", "tax rate can be changed by privileged account")
    else:
        if f.mint_authority_set:
            veto("MINT_AUTHORITY", "mint authority not revoked")
        if f.freeze_authority_set:
            veto("FREEZE_AUTHORITY", "freeze authority not revoked (positions can be frozen)")
        if f.permanent_delegate_set:
            veto("PERMANENT_DELEGATE", "Token-2022 permanent delegate can move/burn any balance")
        if f.transfer_hook_set:
            veto("TRANSFER_HOOK", "Token-2022 transfer hook: arbitrary code on transfer")
        if f.transfer_fee_bps is not None and f.transfer_fee_bps > th.max_token2022_transfer_fee_bps:
            veto("TRANSFER_FEE", f"Token-2022 transfer fee {f.transfer_fee_bps} bps")

    # liquidity / LP
    if f.liquidity_usd is not None and f.liquidity_usd < th.min_liquidity_usd:
        veto("LOW_LIQUIDITY", f"liquidity ${f.liquidity_usd:,.0f} < ${th.min_liquidity_usd:,.0f}")
    if f.lp_controlled_by_deployer:
        veto("LP_DEPLOYER_CONTROLLED", "LP tokens controlled by deployer / unlocked")
    if f.lp_locked_pct is not None and f.lp_locked_pct >= 50 and f.lp_lock_verified is False:
        veto("FAKE_OR_UNVERIFIED_LP_LOCK", f"lock claimed ({f.lp_locked_pct:.0f}%) but not verified on-chain")
    if f.lp_lock_verified and (f.lp_lock_remaining_days is None or f.lp_lock_remaining_days < th.min_lp_lock_days):
        veto("LP_LOCK_TOO_SHORT", f"verified lock remaining {f.lp_lock_remaining_days} days < {th.min_lp_lock_days}")
    if f.lp_lock_verified and (f.lp_locked_pct is None or f.lp_locked_pct < 80):
        veto("LP_LOCK_PARTIAL", f"verified lock covers only {f.lp_locked_pct}% of LP")
    if f.lp_lock_verified is False and (f.lp_locked_pct is None or f.lp_locked_pct < 50):
        veto("NO_LP_LOCK", "LP not locked")

    # holders
    if f.top1_holder_pct is not None and f.top1_holder_pct > th.max_top1_holder_pct:
        veto("HOLDER_CONCENTRATION_TOP1", f"top holder {f.top1_holder_pct}%")
    if f.top10_holder_pct is not None and f.top10_holder_pct > th.max_top10_holder_pct:
        veto("HOLDER_CONCENTRATION_TOP10", f"top-10 holders {f.top10_holder_pct}%")
    if f.deployer_holder_pct is not None and f.deployer_holder_pct > th.max_deployer_holder_pct:
        veto("DEPLOYER_HOLDS_SUPPLY", f"deployer holds {f.deployer_holder_pct}%")
    if f.sybil_cluster_pct is not None and f.sybil_cluster_pct > th.max_sybil_cluster_pct:
        veto("SYBIL_CLUSTER", f"commonly-funded wallets hold {f.sybil_cluster_pct}%")
    if f.deployer_prior_rugs is not None and f.deployer_prior_rugs > 0:
        veto("SERIAL_RUG_DEPLOYER", f"deployer linked to {f.deployer_prior_rugs} prior rug(s)")

    # soft warnings
    if f.age_hours is not None and f.age_hours < 1:
        warn("VERY_NEW", f"token is {f.age_hours:.2f}h old")
    if f.sell_tax_bps is not None and 300 < f.sell_tax_bps <= th.max_sell_tax_bps:
        warn("NONTRIVIAL_SELL_TAX", f"sell tax {f.sell_tax_bps} bps erodes edge")
    if f.exit_depth_usd is not None and f.liquidity_usd and f.exit_depth_usd < 0.25 * f.liquidity_usd:
        warn("THIN_EXIT_DEPTH", "effective exit depth is < 25% of headline liquidity")

    # vendor evidence: additive only
    notes: list[str] = []
    vendor_penalty = 0.0
    for v in f.vendors:
        if v.age_seconds > th.vendor_max_age_seconds:
            notes.append(f"{v.vendor}: stale ({v.age_seconds:.0f}s) ignored")
            continue
        if v.risk_score is None:
            notes.append(f"{v.vendor}: unavailable")
            continue
        if v.risk_score >= 60 or v.flags:
            warn("VENDOR_FLAG", f"{v.vendor} risk {v.risk_score} flags={list(v.flags)}")
            vendor_penalty += min(20.0, v.risk_score / 5)
            notes.append(f"{v.vendor}: negative evidence added")
        else:
            notes.append(f"{v.vendor}: low risk score recorded; does NOT override native checks")

    known = len(crit) - len(unknown)
    confidence = known / len(crit)
    score = max(0.0, 100.0 - 12.0 * len(V) - 4.0 * len(W) - vendor_penalty - 25.0 * (1 - confidence))
    passed = not V
    expl = "PASS: no veto" if passed else "REJECT: " + ", ".join(sorted({x.code for x in V}))
    return GateDecision(passed, tuple(V), tuple(W), round(score, 2), round(confidence, 4), tuple(notes), expl)


@dataclass(frozen=True)
class StrategyAdmission:
    strategy: str
    min_liquidity_usd: float = 50_000.0
    max_position_pct_of_exit_depth: float = 2.0       # position <= 2% of effective exit depth
    max_roundtrip_tax_bps: float = 400.0
    min_age_hours: float = 0.0
    min_net_edge_bps: float = 50.0
    max_top10_holder_pct: float = 40.0


@dataclass(frozen=True)
class AdmissionDecision:
    admitted: bool
    stage1: GateDecision
    reasons: tuple[str, ...]
    net_edge_bps: float | None
    max_position_usd: float | None


def admit(f: TokenFindings, adm: StrategyAdmission, position_usd: float, expected_gross_edge_bps: float,
          est_slippage_bps: float, gate: GateDecision | None = None, th: GateThresholds | None = None) -> AdmissionDecision:
    """Stage 2 runs ONLY if stage 1 passed. Net edge = gross edge - buy tax - sell tax - 2x slippage."""
    g = gate or universal_gate(f, th)
    if not g.passed:
        return AdmissionDecision(False, g, ("stage1 gate rejected: " + g.explanation,), None, None)
    R: list[str] = []
    if f.liquidity_usd < adm.min_liquidity_usd:
        R.append(f"liquidity ${f.liquidity_usd:,.0f} < strategy minimum ${adm.min_liquidity_usd:,.0f}")
    max_pos = f.exit_depth_usd * adm.max_position_pct_of_exit_depth / 100.0
    if position_usd > max_pos:
        R.append(f"position ${position_usd:,.0f} > {adm.max_position_pct_of_exit_depth}% of exit depth (${max_pos:,.0f})")
    rt_tax = f.buy_tax_bps + f.sell_tax_bps
    if rt_tax > adm.max_roundtrip_tax_bps:
        R.append(f"round-trip tax {rt_tax} bps > {adm.max_roundtrip_tax_bps}")
    if f.age_hours < adm.min_age_hours:
        R.append(f"age {f.age_hours}h < {adm.min_age_hours}h")
    if f.top10_holder_pct > adm.max_top10_holder_pct:
        R.append(f"top-10 holders {f.top10_holder_pct}% > {adm.max_top10_holder_pct}%")
    net = expected_gross_edge_bps - rt_tax - 2 * est_slippage_bps
    if net < adm.min_net_edge_bps:
        R.append(f"net edge {net:.1f} bps < required {adm.min_net_edge_bps} bps after taxes+slippage")
    return AdmissionDecision(not R, g, tuple(R), net, max_pos)
