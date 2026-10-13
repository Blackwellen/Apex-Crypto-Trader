// Simulation wrapper over eth_call + eth_estimateGas. Never signs or sends.
import { decodeRevert } from './abi.ts';
import { addressKey } from './address.ts';
import type { CallRequest, EvmRpcClient } from './rpc.ts';
import { RpcError } from './rpc.ts';

export interface SimulationResult {
  ok: boolean;
  returnData?: string;
  gasEstimate?: bigint;
  /** gasEstimate * (1 + bufferBps/10000), capped by maxGasLimit */
  gasLimit?: bigint;
  revert?: { kind: string; message: string };
}
export interface SimulateOptions {
  /** if given, `to` MUST be on this list (no blind contract calls) */
  allowedTargets?: readonly string[];
  gasBufferBps?: bigint; maxGasLimit?: bigint;
}
export class TargetNotAllowed extends Error {
  constructor(to: string | undefined) { super(`simulation target ${to ?? '(none)'} is not allowlisted; blind contract call refused`); this.name = 'TargetNotAllowed'; }
}

export async function simulate(client: EvmRpcClient, tx: CallRequest, opts: SimulateOptions = {}): Promise<SimulationResult> {
  if (opts.allowedTargets) {
    if (!tx.to) throw new TargetNotAllowed(tx.to);
    const k = addressKey(tx.to);
    if (!opts.allowedTargets.some((a) => addressKey(a) === k)) throw new TargetNotAllowed(tx.to);
  }
  let returnData: string;
  try { returnData = await client.call(tx); }
  catch (e) {
    if (e instanceof RpcError) {
      const d = typeof e.data === 'string' ? e.data : undefined;
      const r = decodeRevert(d);
      return { ok: false, revert: { kind: r.kind, message: r.kind === 'empty' && e.message ? e.message : r.message } };
    }
    throw e;
  }
  let gas: bigint;
  try { gas = await client.estimateGas(tx); }
  catch (e) {
    if (e instanceof RpcError) return { ok: false, returnData, revert: { kind: 'estimate_failed', message: e.message } };
    throw e;
  }
  const buf = opts.gasBufferBps ?? 12_000n;
  let limit = (gas * buf + 9_999n) / 10_000n;
  if (opts.maxGasLimit !== undefined && limit > opts.maxGasLimit) {
    if (gas > opts.maxGasLimit) return { ok: false, returnData, gasEstimate: gas, revert: { kind: 'gas_cap', message: `estimate ${gas} exceeds maxGasLimit ${opts.maxGasLimit}` } };
    limit = opts.maxGasLimit;
  }
  return { ok: true, returnData, gasEstimate: gas, gasLimit: limit };
}
