/**
 * TRON resource model: Bandwidth (all txs) and Energy (smart-contract execution), with TRX burned (in sun,
 * 1 TRX = 1_000_000 sun) when the account lacks the resource. EVERY price/limit comes from a
 * /wallet/getchainparameters response - no constants are hardcoded here. If a required key is missing we throw.
 */
export const SUN_PER_TRX = 1_000_000n;

export interface ChainParameterEntry { key: string; value?: number | string | bigint }
export interface GetChainParametersResponse { chainParameter: ChainParameterEntry[] }

export interface TronChainParams {
  /** sun burned per Energy unit (getEnergyFee) */
  energyFeeSun: bigint;
  /** sun burned per bandwidth byte (getTransactionFee) */
  bandwidthFeeSun: bigint;
  /** max fee_limit the network accepts, sun (getMaxFeeLimit) */
  maxFeeLimitSun: bigint;
  /** daily free bandwidth per account (getFreeNetLimit) */
  freeNetLimit: bigint;
  /** sun burned to activate a brand-new account via TransferContract (getCreateNewAccountFeeInSystemContract) */
  activationFeeSun: bigint;
  /** extra bandwidth-style fee (getCreateAccountFee), reported, applied by the node on account creation */
  createAccountFeeSun: bigint;
  memoFeeSun: bigint;
  dynamicEnergyEnabled: boolean;
  dynamicEnergyMaxFactor: bigint;
  raw: Record<string, bigint>;
}

/** TRON omits zero-valued parameters from the response (e.g. {"key":"getAllowMarketTransaction"}); absent value => 0. */
export function parseChainParameters(resp: GetChainParametersResponse): TronChainParams {
  if (!resp || !Array.isArray(resp.chainParameter)) throw new Error('getChainParameters: missing chainParameter array');
  const raw: Record<string, bigint> = {};
  for (const e of resp.chainParameter) raw[e.key] = e.value === undefined ? 0n : BigInt(e.value);
  const need = (k: string): bigint => {
    if (!(k in raw)) throw new Error(`getChainParameters: required key ${k} missing`);
    return raw[k]!;
  };
  const opt = (k: string): bigint => raw[k] ?? 0n;
  const p: TronChainParams = {
    energyFeeSun: need('getEnergyFee'),
    bandwidthFeeSun: need('getTransactionFee'),
    maxFeeLimitSun: need('getMaxFeeLimit'),
    freeNetLimit: need('getFreeNetLimit'),
    activationFeeSun: opt('getCreateNewAccountFeeInSystemContract'),
    createAccountFeeSun: opt('getCreateAccountFee'),
    memoFeeSun: opt('getMemoFee'),
    dynamicEnergyEnabled: opt('getAllowDynamicEnergy') === 1n,
    dynamicEnergyMaxFactor: opt('getDynamicEnergyMaxFactor'),
    raw,
  };
  if (p.energyFeeSun <= 0n || p.bandwidthFeeSun <= 0n) throw new Error('getChainParameters: non-positive fee parameter');
  return p;
}

export type TronTxKind = 'native_transfer' | 'trc10_transfer' | 'contract_call' | 'other';
/** Map a transaction raw_data.contract[0].type to our cost class. Contract calls consume Energy; transfers do not. */
export function classifyContractType(type: string): TronTxKind {
  switch (type) {
    case 'TransferContract': return 'native_transfer';
    case 'TransferAssetContract': return 'trc10_transfer';
    case 'TriggerSmartContract':
    case 'CreateSmartContract': return 'contract_call';
    default: return 'other';
  }
}

const SIG_BYTES = 65n;
/** Node adds a result placeholder when computing bandwidth usage (MAX_RESULT_SIZE_IN_TX = 64). Documented estimate. */
const RESULT_PLACEHOLDER_BYTES = 64n;
export function txBandwidthBytes(rawDataBytes: number, signatures = 1): bigint {
  return BigInt(rawDataBytes) + SIG_BYTES * BigInt(signatures) + RESULT_PLACEHOLDER_BYTES;
}

export interface AccountResources {
  /** staked (Stake 2.0) bandwidth available now = NetLimit - NetUsed (from getaccountresource, recovered) */
  stakedBandwidthAvailable: bigint;
  /** free bandwidth available now = freeNetLimit - freeNetUsed */
  freeBandwidthAvailable: bigint;
  energyAvailable: bigint;
}

export interface BurnEstimateInput {
  kind: TronTxKind;
  bandwidthBytes: bigint;
  /** energy the call is expected to use (from triggerconstantcontract / estimateenergy); ignored for pure transfers */
  energyRequired?: bigint;
  /** contract-specific dynamic-energy penalty factor, basis 10_000 (0 = none) */
  dynamicEnergyPenaltyBps?: bigint;
  recipientIsNewAccount?: boolean;
  resources: AccountResources;
  params: TronChainParams;
}
export interface BurnEstimate {
  bandwidthBurnSun: bigint;
  energyBurnSun: bigint;
  activationBurnSun: bigint;
  totalBurnSun: bigint;
  energyUsedFromStake: bigint;
  energyBurned: bigint;
  bandwidthSource: 'staked' | 'free' | 'burn';
  notes: string[];
}

export function estimateBurn(i: BurnEstimateInput): BurnEstimate {
  const notes: string[] = [];
  let bandwidthSource: BurnEstimate['bandwidthSource'];
  let bandwidthBurnSun = 0n;
  // Network rule: whole-tx bandwidth is taken from staked, else free, else the full size is burned in TRX.
  if (i.resources.stakedBandwidthAvailable >= i.bandwidthBytes) bandwidthSource = 'staked';
  else if (i.resources.freeBandwidthAvailable >= i.bandwidthBytes) bandwidthSource = 'free';
  else { bandwidthSource = 'burn'; bandwidthBurnSun = i.bandwidthBytes * i.params.bandwidthFeeSun; }

  let energyBurnSun = 0n, energyBurned = 0n, energyFromStake = 0n;
  if (i.kind === 'contract_call') {
    const base = i.energyRequired ?? 0n;
    if (i.energyRequired === undefined) notes.push('energyRequired not supplied: contract-call energy burn UNDERESTIMATED (simulate first)');
    const penalty = i.dynamicEnergyPenaltyBps ?? 0n;
    if (penalty > 0n && !i.params.dynamicEnergyEnabled) notes.push('penalty supplied but dynamic energy disabled on chain');
    const need = base + (base * penalty + 9_999n) / 10_000n;
    energyFromStake = need < i.resources.energyAvailable ? need : i.resources.energyAvailable;
    energyBurned = need - energyFromStake;
    energyBurnSun = energyBurned * i.params.energyFeeSun;
  } else if (i.energyRequired && i.energyRequired > 0n) notes.push('energyRequired ignored for non-contract tx');

  const activationBurnSun = i.recipientIsNewAccount && (i.kind === 'native_transfer' || i.kind === 'trc10_transfer') ? i.params.activationFeeSun : 0n;
  return {
    bandwidthBurnSun, energyBurnSun, activationBurnSun,
    totalBurnSun: bandwidthBurnSun + energyBurnSun + activationBurnSun,
    energyUsedFromStake: energyFromStake, energyBurned, bandwidthSource, notes,
  };
}

export interface FeeLimitInput {
  energyEstimate: bigint;
  params: TronChainParams;
  /** safety buffer over the estimate, basis points (e.g. 2000 = +20%) */
  bufferBps: bigint;
  /** TRX balance in sun available for fees (after reserve) */
  spendableSun: bigint;
  /** economic cap the caller (risk policy) is willing to burn, sun */
  policyCapSun: bigint;
}
export interface FeeLimitResult { ok: boolean; feeLimitSun: bigint; reason?: string; clampedBy?: 'network' | 'policy' | 'balance' }

/**
 * fee_limit is the MAX TRX a contract call may burn. Too low => OUT_OF_ENERGY revert (fee still burned);
 * too high => exposes balance. Bound: estimate*(1+buffer) clamped to network max, policy cap, and spendable balance.
 * If the clamp drops the limit below the raw estimate the call is REFUSED rather than sent to fail.
 */
export function safeFeeLimit(i: FeeLimitInput): FeeLimitResult {
  if (i.energyEstimate <= 0n) return { ok: false, feeLimitSun: 0n, reason: 'energy estimate must be positive (simulate first)' };
  if (i.bufferBps < 0n) return { ok: false, feeLimitSun: 0n, reason: 'negative buffer' };
  const minNeeded = i.energyEstimate * i.params.energyFeeSun;
  const want = (minNeeded * (10_000n + i.bufferBps) + 9_999n) / 10_000n;
  let limit = want; let clampedBy: FeeLimitResult['clampedBy'];
  if (limit > i.params.maxFeeLimitSun) { limit = i.params.maxFeeLimitSun; clampedBy = 'network'; }
  if (limit > i.policyCapSun) { limit = i.policyCapSun; clampedBy = 'policy'; }
  if (limit > i.spendableSun) { limit = i.spendableSun; clampedBy = 'balance'; }
  if (limit < minNeeded) return { ok: false, feeLimitSun: limit, clampedBy, reason: `fee_limit ${limit} below minimum required ${minNeeded} (would fail OUT_OF_ENERGY)` };
  return { ok: true, feeLimitSun: limit, clampedBy };
}

export interface TrxReserveInput {
  params: TronChainParams;
  plannedTxCount: number;
  /** typical tx: bandwidth bytes + energy */
  perTx: { bandwidthBytes: bigint; energy: bigint };
  /** emergency exit tx shape (e.g. approve-revoke + swap sell) */
  exit: { bandwidthBytes: bigint; energy: bigint };
  /** absolute floor in sun the policy never lets the wallet go below */
  floorSun: bigint;
}
/** Worst case: assume NO staked/free resources (everything burned). Conservative by design. */
export function trxReserve(i: TrxReserveInput): { floor: bigint; nextNTxEstimate: bigint; emergencyExit: bigint; total: bigint } {
  const cost = (s: { bandwidthBytes: bigint; energy: bigint }): bigint => s.bandwidthBytes * i.params.bandwidthFeeSun + s.energy * i.params.energyFeeSun;
  const nextNTxEstimate = cost(i.perTx) * BigInt(i.plannedTxCount);
  const emergencyExit = cost(i.exit);
  return { floor: i.floorSun, nextNTxEstimate, emergencyExit, total: i.floorSun + nextNTxEstimate + emergencyExit };
}

/** Finality: TRON solidified block (>= 2/3 SR confirmation, ~19 blocks). Compare tx block to solidified (getnowblock on solidity node). */
export function isSolidified(txBlock: bigint, solidifiedBlock: bigint): boolean {
  return txBlock <= solidifiedBlock;
}
