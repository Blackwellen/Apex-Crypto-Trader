// Simulation wrapper: run /transactions/simulate and turn the VM verdict into a go/no-go with a gas bound. Never submits.
import { maxGasFromSimulation } from './gas.ts';
import type { AptosRestClient } from './rest.ts';

export interface AptosSimOutcome { ok: boolean; vmStatus: string; gasUsed: bigint; /** recommended max_gas_amount (buffered, capped) when ok */ maxGasAmount?: bigint; reason?: string }
export async function simulateTransaction(client: AptosRestClient, signedTxBcsWithZeroSignature: Uint8Array, o: { maxGasCap: bigint; bufferBps?: bigint }): Promise<AptosSimOutcome> {
  const s = await client.simulate(signedTxBcsWithZeroSignature);
  if (!s.success) return { ok: false, vmStatus: s.vmStatus, gasUsed: s.gasUsed, reason: `simulation failed: ${s.vmStatus}` };
  try { return { ok: true, vmStatus: s.vmStatus, gasUsed: s.gasUsed, maxGasAmount: maxGasFromSimulation(s.gasUsed, { cap: o.maxGasCap, ...(o.bufferBps !== undefined ? { bufferBps: o.bufferBps } : {}) }) }; }
  catch (e) { return { ok: false, vmStatus: s.vmStatus, gasUsed: s.gasUsed, reason: (e as Error).message }; }
}
