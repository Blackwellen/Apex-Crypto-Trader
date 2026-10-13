// Rent / ATA existence reserve and wallet lamports reserve.
import type { NativeReserve } from '@apex/contracts';
import type { Token2022ExtensionName } from './token2022.ts';
import type { SolanaRpcClient } from './rpc.ts';

/** rent-exempt minimum = (dataLen + accountStorageOverhead) * lamportsPerByte. */
export interface RentParams { lamportsPerByte: bigint; accountStorageOverhead: bigint }
/**
 * Legacy schedule (3480 lamports/byte-year * 2 years). LIVE FINDING (2026-10-13): mainnet/devnet/testnet nodes now answer
 * getMinimumBalanceForRentExemption(0)=650_240 and (165)=1_488_440, i.e. 5080 lamports/byte -- the old constant is stale.
 * It is kept ONLY as a conservative (higher => over-reserve) fallback; production must derive params from the node (rentParamsFromNode).
 */
export const LEGACY_RENT: RentParams = { lamportsPerByte: 6_960n, accountStorageOverhead: 128n };
export const DEFAULT_RENT: RentParams = LEGACY_RENT;
export const OBSERVED_RENT_2026_10_13: RentParams = { lamportsPerByte: 5_080n, accountStorageOverhead: 128n };

export function rentExemptMinimum(dataLen: number, p: RentParams = DEFAULT_RENT): bigint {
  if (!Number.isInteger(dataLen) || dataLen < 0) throw new Error('bad data length');
  return (BigInt(dataLen) + p.accountStorageOverhead) * p.lamportsPerByte;
}
export const SYSTEM_ACCOUNT_RENT_FLOOR = (p: RentParams = DEFAULT_RENT) => rentExemptMinimum(0, p);

/** Derive the live rent schedule from the node and cross-check it on a second length (rejects a node whose answers are not linear in size). */
export async function rentParamsFromNode(client: Pick<SolanaRpcClient, 'getMinimumBalanceForRentExemption'>): Promise<RentParams> {
  const overhead = 128n;
  const min0 = await client.getMinimumBalanceForRentExemption(0);
  if (min0 === 0n || min0 % overhead !== 0n) throw new Error(`rent for 0 bytes (${min0}) is not a multiple of ${overhead}; cannot derive lamports/byte`);
  const p: RentParams = { lamportsPerByte: min0 / overhead, accountStorageOverhead: overhead };
  const min165 = await client.getMinimumBalanceForRentExemption(165);
  if (min165 !== rentExemptMinimum(165, p)) throw new Error(`rent schedule not linear: node says ${min165} for 165 bytes, model ${rentExemptMinimum(165, p)}`);
  return p;
}
export const SPL_TOKEN_ACCOUNT_LEN = 165;
export const SPL_MINT_LEN = 82;

/** Account-side TLV extension value lengths needed in a Token-2022 token account (only those we model). */
const ACCOUNT_EXT_LEN: Partial<Record<Token2022ExtensionName, number>> = {
  ImmutableOwner: 0, TransferFeeAmount: 8, NonTransferableAccount: 0, TransferHookAccount: 1, PausableAccount: 0,
};
/** Mint extension -> the token-account extension Token-2022 initialises automatically (ExtensionType::get_required_init_account_extensions). */
const REQUIRED_FOR_MINT_EXT: Partial<Record<Token2022ExtensionName, Token2022ExtensionName>> = {
  TransferFeeConfig: 'TransferFeeAmount', NonTransferable: 'NonTransferableAccount', TransferHook: 'TransferHookAccount', Pausable: 'PausableAccount',
};
export interface AtaSizing { len: number; modelled: boolean; unmodelled: string[] }
/** Size of an associated token account for the given mint. ATAs always carry ImmutableOwner under Token-2022. */
export function ataAccountLen(program: 'spl-token' | 'token-2022', mintExtensions: Token2022ExtensionName[] = []): AtaSizing {
  if (program === 'spl-token') return { len: SPL_TOKEN_ACCOUNT_LEN, modelled: true, unmodelled: [] };
  const needed = new Set<Token2022ExtensionName>(['ImmutableOwner']);
  const unmodelled: string[] = [];
  for (const e of mintExtensions) {
    const req = REQUIRED_FOR_MINT_EXT[e];
    if (req) needed.add(req);
    if (e === 'ConfidentialTransferMint' || e === 'ConfidentialTransferFeeConfig') unmodelled.push(`${e}: confidential account extension size not modelled`);
  }
  let len = SPL_TOKEN_ACCOUNT_LEN + 1; // + account-type byte
  for (const e of needed) len += 4 + (ACCOUNT_EXT_LEN[e] ?? 0);
  return { len, modelled: unmodelled.length === 0, unmodelled };
}

export interface AtaReserve { lamports: bigint; accountLen: number; needsCreation: boolean; modelled: boolean; unmodelled: string[] }
/** Lamports that must be funded to create the destination ATA (0 if it already exists). Existence MUST come from a fresh getAccountInfo, not a cache. */
export function ataCreationReserve(o: { ataExists: boolean; program: 'spl-token' | 'token-2022'; mintExtensions?: Token2022ExtensionName[]; rent?: RentParams }): AtaReserve {
  const sz = ataAccountLen(o.program, o.mintExtensions);
  if (o.ataExists) return { lamports: 0n, accountLen: sz.len, needsCreation: false, modelled: sz.modelled, unmodelled: sz.unmodelled };
  return { lamports: rentExemptMinimum(sz.len, o.rent), accountLen: sz.len, needsCreation: true, modelled: sz.modelled, unmodelled: sz.unmodelled };
}

export interface LamportsReserveConfig {
  /** keep the fee-payer system account rent-exempt: default rentExemptMinimum(0) */
  rentFloor?: bigint; extraFloor?: bigint;
  /** worst-case lamports for one planned tx: base+priority+tip (+ new account rent if known) */
  perTxCost: bigint;
  /** cost to exit (sell/close) once, absorbing a fee spike */
  emergencyExitCost: bigint; emergencyMultiplierBps?: bigint;
}
export function computeLamportsReserve(chainId: string, cfg: LamportsReserveConfig, opts: { plannedTxCount: number }): NativeReserve {
  if (!Number.isInteger(opts.plannedTxCount) || opts.plannedTxCount < 0) throw new Error('plannedTxCount must be a non-negative integer');
  const floor = (cfg.rentFloor ?? SYSTEM_ACCOUNT_RENT_FLOOR()) + (cfg.extraFloor ?? 0n);
  const next = cfg.perTxCost * BigInt(opts.plannedTxCount);
  const exit = (cfg.emergencyExitCost * (cfg.emergencyMultiplierBps ?? 15_000n) + 9_999n) / 10_000n;
  return { chainId, floor, nextNTxEstimate: next, emergencyExit: exit, total: floor + next + exit };
}
export function spendableLamports(balance: bigint, r: NativeReserve): bigint { const s = balance - r.total; return s > 0n ? s : 0n; }
