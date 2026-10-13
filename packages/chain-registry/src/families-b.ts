// Registers the TRON/Cosmos/Bitcoin/TON/NEAR records (built in separate packages) into the shared registry.
import { registerChains } from './registry.ts';
import { chainRecords as tron } from '@apex/chain-tron/src/records.ts';
import { chainRecords as cosmos } from '@apex/chain-cosmos/src/records.ts';
import { chainRecords as bitcoin } from '@apex/chain-bitcoin/src/records.ts';
import { chainRecords as ton } from '@apex/chain-ton/src/records.ts';
import { chainRecords as near } from '@apex/chain-near/src/records.ts';
export function registerFamiliesB(): void { for (const r of [tron, cosmos, bitcoin, ton, near]) registerChains(r); }
registerFamiliesB();
