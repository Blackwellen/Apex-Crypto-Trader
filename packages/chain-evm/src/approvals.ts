// Allowance + Permit2 helpers. Defaults are restrictive:
//  - NO infinite approvals (unless an explicit, per-call justification flag is set on the policy),
//  - spenders must be on a PER-CHAIN allowlist supplied by the caller; this package hardcodes no router / spender / Permit2 address,
//  - Permit2 permits are exact-amount and short-lived.
import { addressKey, validateEvmAddress } from './address.ts';
import { encodeCall } from './abi.ts';
import type { EvmRpcClient } from './rpc.ts';
import { decodeUintWords } from './abi.ts';

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;

export class ApprovalRefused extends Error {
  code: string;
  constructor(code: string, message: string) { super(`approval refused [${code}]: ${message}`); this.name = 'ApprovalRefused'; this.code = code; }
}

export interface ApprovalPolicy {
  /** CAIP-2 chain id (e.g. eip155:8453) -> allowed spender addresses. Missing/empty chain => nothing allowed. */
  spenderAllowlist: Record<string, readonly string[]>;
  /** CAIP-2 chain id -> Permit2 deployment address (never assumed identical across chains) */
  permit2ByChain?: Record<string, string>;
  /** amounts >= this are "infinite" and refused. Default 2^255. */
  infiniteThreshold?: bigint;
  /** explicit opt-in (default false) */
  allowInfinite?: boolean;
  /** extra headroom over the required amount in bps (default 0 = exact) */
  slackBps?: bigint;
  /** Permit2 max permit lifetime in seconds (default 1800) */
  maxPermitLifetimeSec?: number;
}

function spenderAllowed(policy: ApprovalPolicy, chainId: string, spender: string): boolean {
  const list = policy.spenderAllowlist[chainId];
  if (!list || list.length === 0) return false;
  const k = addressKey(spender);
  return list.some((a) => { try { return addressKey(a) === k; } catch { return false; } });
}

export interface ApprovalRequest { chainId: string; token: string; spender: string; amount: bigint; requiredAmount: bigint }
export interface ApprovalCall { to: string; data: string; description: string }

/** ERC-20 approve(spender, amount) calldata after policy checks. amount===0 (revoke) is always allowed for valid addresses. */
export function buildScopedApprove(req: ApprovalRequest, policy: ApprovalPolicy): ApprovalCall {
  const t = validateEvmAddress(req.token, { rejectZero: true }); if (!t.valid) throw new ApprovalRefused('bad_token', t.reason!);
  const s = validateEvmAddress(req.spender, { rejectZero: true }); if (!s.valid) throw new ApprovalRefused('bad_spender', s.reason!);
  if (req.amount < 0n) throw new ApprovalRefused('negative', 'negative amount');
  const data = encodeCall('approve(address,uint256)', [{ t: 'address', v: s.normalized! }, { t: 'uint', v: req.amount }]);
  if (req.amount === 0n) return { to: t.normalized!, data, description: 'revoke allowance' };
  if (!spenderAllowed(policy, req.chainId, req.spender))
    throw new ApprovalRefused('spender_not_allowlisted', `spender ${req.spender} is not on the allowlist for ${req.chainId}`);
  const inf = policy.infiniteThreshold ?? 1n << 255n;
  if (req.amount >= inf && !policy.allowInfinite) throw new ApprovalRefused('infinite', 'infinite / unlimited approvals are refused by default');
  const maxOk = req.requiredAmount + (req.requiredAmount * (policy.slackBps ?? 0n)) / 10_000n;
  if (req.amount > maxOk && !(policy.allowInfinite && req.amount >= inf))
    throw new ApprovalRefused('over_scope', `amount ${req.amount} exceeds required scope ${maxOk}`);
  return { to: t.normalized!, data, description: `approve ${req.amount} to ${s.normalized!}` };
}

export function needsApproval(currentAllowance: bigint, required: bigint): boolean { return currentAllowance < required; }

/** Tokens that forbid changing a non-zero allowance (USDT-style): reset to 0 first, then approve exact. */
export function buildResetThenApprove(req: ApprovalRequest, policy: ApprovalPolicy, currentAllowance: bigint): ApprovalCall[] {
  const calls: ApprovalCall[] = [];
  if (currentAllowance > 0n) calls.push(buildScopedApprove({ ...req, amount: 0n }, policy));
  calls.push(buildScopedApprove(req, policy));
  return calls;
}

export async function readAllowance(client: EvmRpcClient, token: string, owner: string, spender: string): Promise<bigint> {
  const data = encodeCall('allowance(address,address)', [{ t: 'address', v: owner }, { t: 'address', v: spender }]);
  return decodeUintWords(await client.call({ to: token, data }), 1)[0]!;
}

// ---- Permit2 (EIP-712 PermitSingle) ----
export interface Permit2SingleRequest {
  chainId: string; chainIdNumeric: bigint;
  token: string; spender: string; amount: bigint; expiration: bigint; nonce: bigint; sigDeadline: bigint;
}
export const PERMIT2_SINGLE_TYPES = {
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
} as const;

export function buildPermit2SingleTypedData(req: Permit2SingleRequest, policy: ApprovalPolicy, nowSec: bigint) {
  const permit2 = policy.permit2ByChain?.[req.chainId];
  if (!permit2) throw new ApprovalRefused('no_permit2_address', `no Permit2 deployment configured for ${req.chainId}; none is assumed`);
  if (!validateEvmAddress(permit2, { rejectZero: true }).valid) throw new ApprovalRefused('bad_permit2_address', permit2);
  if (!validateEvmAddress(req.token, { rejectZero: true }).valid) throw new ApprovalRefused('bad_token', req.token);
  if (!spenderAllowed(policy, req.chainId, req.spender)) throw new ApprovalRefused('spender_not_allowlisted', `spender ${req.spender} not allowlisted for ${req.chainId}`);
  if (req.amount <= 0n) throw new ApprovalRefused('zero_amount', 'permit amount must be > 0');
  if (req.amount >= MAX_UINT160) throw new ApprovalRefused('infinite', 'Permit2 max-uint160 amount is an unlimited permit');
  if (req.nonce < 0n || req.nonce > MAX_UINT48) throw new ApprovalRefused('bad_nonce', 'nonce outside uint48');
  const maxLife = BigInt(policy.maxPermitLifetimeSec ?? 1800);
  if (req.expiration <= nowSec) throw new ApprovalRefused('expired', 'permit expiration is in the past');
  if (req.expiration - nowSec > maxLife) throw new ApprovalRefused('long_lived', `permit lifetime exceeds ${maxLife}s`);
  if (req.expiration > MAX_UINT48) throw new ApprovalRefused('bad_expiration', 'expiration outside uint48');
  if (req.sigDeadline <= nowSec) throw new ApprovalRefused('sig_deadline_expired', 'sigDeadline is in the past');
  if (req.sigDeadline - nowSec > maxLife) throw new ApprovalRefused('long_lived', `signature deadline exceeds ${maxLife}s`);
  return {
    domain: { name: 'Permit2', chainId: req.chainIdNumeric, verifyingContract: validateEvmAddress(permit2).normalized! },
    types: PERMIT2_SINGLE_TYPES, primaryType: 'PermitSingle' as const,
    message: {
      details: { token: validateEvmAddress(req.token).normalized!, amount: req.amount, expiration: req.expiration, nonce: req.nonce },
      spender: validateEvmAddress(req.spender).normalized!, sigDeadline: req.sigDeadline,
    },
  };
}
