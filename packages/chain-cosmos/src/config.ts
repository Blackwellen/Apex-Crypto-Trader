/** Extensible per-chain config. Add a chain by adding an entry; fee prices are NOT stored (queried per node). */
export interface CosmosChainConfig {
  chainId: string; name: string; bech32Prefix: string; nativeDenom: string; nativeSymbol: string; decimals: number;
  feeDenoms: string[]; lcd: string[]; explorer?: string; isTestnet: boolean;
}
export const COSMOS_CHAINS: CosmosChainConfig[] = [
  { chainId: 'cosmoshub-4', name: 'Cosmos Hub', bech32Prefix: 'cosmos', nativeDenom: 'uatom', nativeSymbol: 'ATOM', decimals: 6, feeDenoms: ['uatom'], lcd: ['https://cosmos-rest.publicnode.com'], explorer: 'https://www.mintscan.io/cosmos', isTestnet: false },
  { chainId: 'osmosis-1', name: 'Osmosis', bech32Prefix: 'osmo', nativeDenom: 'uosmo', nativeSymbol: 'OSMO', decimals: 6, feeDenoms: ['uosmo'], lcd: ['https://osmosis-rest.publicnode.com'], explorer: 'https://www.mintscan.io/osmosis', isTestnet: false },
];
export function registerChain(cfg: CosmosChainConfig, list: CosmosChainConfig[] = COSMOS_CHAINS): CosmosChainConfig[] {
  if (!/^[a-z0-9-]+-\d+$|^[a-z0-9-]+$/.test(cfg.chainId)) throw new Error('bad chain id');
  if (!/^[a-z]+$/.test(cfg.bech32Prefix)) throw new Error('bad bech32 prefix');
  if (list.some((c) => c.chainId === cfg.chainId)) throw new Error(`duplicate chain ${cfg.chainId}`);
  return [...list, cfg];
}
