// L2 extra data-fee modelling. The L1 data / DA component is a SEPARATE fee component and is never guessed:
// chains whose component we do not model are reported as unknown.
import { decodeUintWords, encodeCall } from './abi.ts';
import type { EvmRpcClient } from './rpc.ts';

export type L2Stack = 'none' | 'op-stack' | 'arbitrum' | 'zksync' | 'linea' | 'scroll' | 'mantle';
export interface L2FeeSpec { stack: L2Stack; modelled: boolean; componentName: string; note: string }

/** Keyed by EIP-155 chain id (decimal string). Anything absent => treated as UNKNOWN stack (fail closed). */
const SPECS: Record<string, L2FeeSpec> = {
  '1': { stack: 'none', modelled: true, componentName: 'none', note: 'L1: no extra data fee' },
  '137': { stack: 'none', modelled: true, componentName: 'none', note: 'Polygon PoS is not a rollup; no L1 data component' },
  '56': { stack: 'none', modelled: true, componentName: 'none', note: 'BSC: no L1 data component' },
  '43114': { stack: 'none', modelled: true, componentName: 'none', note: 'Avalanche C-Chain: no L1 data component' },
  '8453': { stack: 'op-stack', modelled: true, componentName: 'l1DataFee', note: 'OP-stack: GasPriceOracle.getL1Fee(bytes) predeploy' },
  '10': { stack: 'op-stack', modelled: true, componentName: 'l1DataFee', note: 'OP-stack: GasPriceOracle.getL1Fee(bytes) predeploy' },
  '81457': { stack: 'op-stack', modelled: true, componentName: 'l1DataFee', note: 'OP-stack (Blast): GasPriceOracle predeploy; Blast-specific yield/gas modes NOT modelled' },
  '42161': { stack: 'arbitrum', modelled: true, componentName: 'l1Component', note: 'Arbitrum: NodeInterface.gasEstimateComponents (gasEstimateForL1 * L2 baseFee)' },
  '324': { stack: 'zksync', modelled: false, componentName: 'pubdataFee', note: 'zkSync Era pubdata/L1 gas-per-pubdata model NOT modelled; unknown' },
  '59144': { stack: 'linea', modelled: false, componentName: 'l1DataFee', note: 'Linea L1 data component NOT modelled; unknown' },
  '534352': { stack: 'scroll', modelled: false, componentName: 'l1DataFee', note: 'Scroll L1 data fee (L1 oracle) NOT modelled; unknown' },
  '5000': { stack: 'mantle', modelled: false, componentName: 'l1DataFee', note: 'Mantle (OP-stack derivative with own DA/oracle) NOT modelled; unknown' },
};

export function l2FeeSpec(chainId: bigint | number | string): L2FeeSpec {
  return SPECS[String(chainId)] ?? { stack: 'none', modelled: false, componentName: 'unknownL2Component', note: 'chain not classified: L2 data fee UNKNOWN' };
}

/** OP-stack GasPriceOracle predeploy address (documented fixed predeploy on OP-stack chains). */
export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
/** Arbitrum NodeInterface virtual contract (address 0xC8). */
export const ARB_NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';

export function encodeOpGetL1Fee(unsignedTxRlpHex: string): string { return encodeCall('getL1Fee(bytes)', [{ t: 'bytes', v: unsignedTxRlpHex }]); }
export async function opL1Fee(client: EvmRpcClient, unsignedTxRlpHex: string): Promise<bigint> {
  const out = await client.call({ to: OP_GAS_PRICE_ORACLE, data: encodeOpGetL1Fee(unsignedTxRlpHex) });
  return decodeUintWords(out, 1)[0]!;
}

export function encodeArbGasEstimateComponents(to: string, contractCreation: boolean, data: string): string {
  return encodeCall('gasEstimateComponents(address,bool,bytes)', [{ t: 'address', v: to }, { t: 'bool', v: contractCreation }, { t: 'bytes', v: data }]);
}
/** returns (gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate); L1 cost in wei = gasEstimateForL1 * baseFee. */
export function decodeArbComponents(out: string): { gasEstimate: bigint; gasEstimateForL1: bigint; baseFee: bigint; l1BaseFeeEstimate: bigint; l1FeeWei: bigint } {
  const [gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate] = decodeUintWords(out, 4) as [bigint, bigint, bigint, bigint];
  return { gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate, l1FeeWei: gasEstimateForL1 * baseFee };
}
export async function arbL1Component(client: EvmRpcClient, to: string, data: string, from?: string) {
  const out = await client.call({ ...(from ? { from } : {}), to: ARB_NODE_INTERFACE, data: encodeArbGasEstimateComponents(to, false, data) });
  return decodeArbComponents(out);
}

export type L2Component = { name: string; amount?: bigint; known: boolean; note?: string };
/** Build the L2 components list for a quote: known amount when supplied for a modelled stack, otherwise UNKNOWN (never guessed). */
export function l2Components(chainId: bigint | number | string, measured?: { l1Fee?: bigint }): L2Component[] {
  const spec = l2FeeSpec(chainId);
  if (spec.stack === 'none' && spec.modelled) return [];
  if (spec.modelled && measured?.l1Fee !== undefined) return [{ name: spec.componentName, amount: measured.l1Fee, known: true, note: spec.note }];
  return [{ name: spec.componentName, known: false, note: spec.modelled ? 'modelled but not measured for this tx' : spec.note }];
}
