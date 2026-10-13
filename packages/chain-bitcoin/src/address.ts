import { base58CheckDecode } from './base58.ts';
import { segwitDecode } from './segwit.ts';

export type BtcNetwork = 'mainnet' | 'testnet';
export type BtcScriptType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';
export interface BtcAddressResult { valid: boolean; reason?: string; type?: BtcScriptType; network?: BtcNetwork; normalized?: string }

const B58: Record<number, { type: BtcScriptType; network: BtcNetwork }> = {
  0x00: { type: 'p2pkh', network: 'mainnet' }, 0x05: { type: 'p2sh', network: 'mainnet' },
  0x6f: { type: 'p2pkh', network: 'testnet' }, 0xc4: { type: 'p2sh', network: 'testnet' },
};
const HRP: Record<string, BtcNetwork> = { bc: 'mainnet', tb: 'testnet' };

/**
 * Validates mainnet/testnet(3/4/signet share tb/6f/c4) addresses with full checksum verification.
 * If expectNetwork is given a wrong-network address is rejected (never accept testnet addresses on mainnet flows).
 * Witness v2..v16 are valid per BIP350 but not spendable-by-policy today => rejected by default.
 */
export function validateBitcoinAddress(address: string, expectNetwork?: BtcNetwork): BtcAddressResult {
  if (typeof address !== 'string' || !address) return { valid: false, reason: 'empty' };
  const lower = address.toLowerCase();
  const hrp = Object.keys(HRP).find((h) => lower.startsWith(h + '1'));
  if (hrp) {
    const network = HRP[hrp]!;
    if (expectNetwork && expectNetwork !== network) return { valid: false, reason: `address is ${network}, expected ${expectNetwork}` };
    try {
      const { version, program } = segwitDecode(hrp, address);
      let type: BtcScriptType;
      if (version === 0) type = program.length === 20 ? 'p2wpkh' : 'p2wsh';
      else if (version === 1 && program.length === 32) type = 'p2tr';
      else return { valid: false, reason: `unsupported witness version ${version} / program length ${program.length}` };
      return { valid: true, type, network, normalized: lower };
    } catch (e) { return { valid: false, reason: (e as Error).message }; }
  }
  try {
    const payload = base58CheckDecode(address);
    if (payload.length !== 21) return { valid: false, reason: `payload length ${payload.length} != 21` };
    const meta = B58[payload[0]!];
    if (!meta) return { valid: false, reason: `unknown version byte 0x${payload[0]!.toString(16)}` };
    if (expectNetwork && expectNetwork !== meta.network) return { valid: false, reason: `address is ${meta.network}, expected ${expectNetwork}` };
    return { valid: true, type: meta.type, network: meta.network, normalized: address };
  } catch (e) { return { valid: false, reason: (e as Error).message }; }
}
