// Pure Token / Token-2022 mint parser + risk analyzer. Layouts follow solana-program/token-2022 `interface/src/extension`:
//  - base Mint (82 bytes): COption<mint_authority>(4+32) supply u64 decimals u8 is_initialized u8 COption<freeze_authority>(4+32)
//  - Token-2022 mint with extensions: padded to 165 bytes, byte[165] = AccountType (1=Mint), then TLV {u16 type, u16 len, value}
//  - TransferFeeConfig: authority(32) withdraw_withheld_authority(32) withheld u64 older{epoch u64,max u64,bps u16} newer{...}
//  - TransferHook: authority(32) program_id(32); PermanentDelegate: delegate(32); DefaultAccountState: u8 (2 = Frozen)
import { base58Encode } from './base58.ts';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const EXTENSION_NAMES = [
  'Uninitialized', 'TransferFeeConfig', 'TransferFeeAmount', 'MintCloseAuthority', 'ConfidentialTransferMint', 'ConfidentialTransferAccount',
  'DefaultAccountState', 'ImmutableOwner', 'MemoTransfer', 'NonTransferable', 'InterestBearingConfig', 'CpiGuard', 'PermanentDelegate',
  'NonTransferableAccount', 'TransferHook', 'TransferHookAccount', 'ConfidentialTransferFeeConfig', 'ConfidentialTransferFeeAmount',
  'MetadataPointer', 'TokenMetadata', 'GroupPointer', 'TokenGroup', 'GroupMemberPointer', 'TokenGroupMember', 'ConfidentialMintBurn',
  'ScaledUiAmount', 'Pausable', 'PausableAccount', 'PermissionedBurn',
] as const;
export type Token2022ExtensionName = (typeof EXTENSION_NAMES)[number];

export interface TransferFee { epoch: bigint; maximumFee: bigint; basisPoints: number }
export interface ParsedMint {
  program: 'spl-token' | 'token-2022';
  mintAuthority: string | null; supply: bigint; decimals: number; isInitialized: boolean; freezeAuthority: string | null;
  extensions: { type: number; name: Token2022ExtensionName | 'Unknown'; length: number }[];
  transferFeeConfig?: { configAuthority: string | null; withdrawWithheldAuthority: string | null; withheldAmount: bigint; older: TransferFee; newer: TransferFee };
  permanentDelegate?: string | null;
  transferHook?: { authority: string | null; programId: string | null };
  defaultAccountState?: 'initialized' | 'frozen' | 'uninitialized';
  mintCloseAuthority?: string | null;
}
export class MintParseError extends Error { constructor(m: string) { super(m); this.name = 'MintParseError'; } }

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const optKey = (b: Uint8Array) => (isZero(b) ? null : base58Encode(b)); // OptionalNonZeroPubkey: all-zero == None

export function parseMint(data: Uint8Array, ownerProgram: string): ParsedMint {
  const program = ownerProgram === TOKEN_PROGRAM_ID ? 'spl-token' : ownerProgram === TOKEN_2022_PROGRAM_ID ? 'token-2022' : null;
  if (!program) throw new MintParseError(`account owner ${ownerProgram} is not a token program`);
  if (data.length < 82) throw new MintParseError(`mint data too short: ${data.length}`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const coption = (off: number) => { const tag = dv.getUint32(off, true); if (tag > 1) throw new MintParseError('bad COption tag'); return tag === 1 ? base58Encode(data.slice(off + 4, off + 36)) : null; };
  const mint: ParsedMint = {
    program, mintAuthority: coption(0), supply: dv.getBigUint64(36, true), decimals: dv.getUint8(44), isInitialized: dv.getUint8(45) === 1,
    freezeAuthority: coption(46), extensions: [],
  };
  if (!mint.isInitialized) throw new MintParseError('mint is not initialized');
  if (program === 'spl-token') {
    if (data.length !== 82) throw new MintParseError(`SPL Token mint must be exactly 82 bytes, got ${data.length}`);
    return mint;
  }
  if (data.length === 82) return mint;
  if (data.length <= 165) throw new MintParseError(`Token-2022 mint with length ${data.length} (82 < len <= 165) is malformed`);
  if (data[165] !== 1) throw new MintParseError(`account type byte ${data[165]} is not Mint(1)`);
  let off = 166;
  while (off + 4 <= data.length) {
    const type = dv.getUint16(off, true); const len = dv.getUint16(off + 2, true);
    if (type === 0 && len === 0) break; // zero padding
    if (off + 4 + len > data.length) throw new MintParseError('TLV entry overruns account data');
    const v = data.slice(off + 4, off + 4 + len);
    const name = (EXTENSION_NAMES[type] ?? 'Unknown') as ParsedMint['extensions'][number]['name'];
    mint.extensions.push({ type, name, length: len });
    const vdv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    const tf = (o: number): TransferFee => ({ epoch: vdv.getBigUint64(o, true), maximumFee: vdv.getBigUint64(o + 8, true), basisPoints: vdv.getUint16(o + 16, true) });
    switch (name) {
      case 'TransferFeeConfig':
        if (len !== 108) throw new MintParseError(`TransferFeeConfig length ${len} != 108`);
        mint.transferFeeConfig = { configAuthority: optKey(v.slice(0, 32)), withdrawWithheldAuthority: optKey(v.slice(32, 64)), withheldAmount: vdv.getBigUint64(64, true), older: tf(72), newer: tf(90) };
        break;
      case 'PermanentDelegate':
        if (len !== 32) throw new MintParseError('PermanentDelegate length != 32');
        mint.permanentDelegate = optKey(v); break;
      case 'TransferHook':
        if (len !== 64) throw new MintParseError('TransferHook length != 64');
        mint.transferHook = { authority: optKey(v.slice(0, 32)), programId: optKey(v.slice(32, 64)) }; break;
      case 'DefaultAccountState':
        if (len !== 1) throw new MintParseError('DefaultAccountState length != 1');
        mint.defaultAccountState = v[0] === 0 ? 'uninitialized' : v[0] === 1 ? 'initialized' : 'frozen'; break;
      case 'MintCloseAuthority':
        if (len !== 32) throw new MintParseError('MintCloseAuthority length != 32');
        mint.mintCloseAuthority = optKey(v); break;
      default: break;
    }
    off += 4 + len;
  }
  return mint;
}

export type RiskSeverity = 'info' | 'warn' | 'block';
export type RiskCode = 'TRANSFER_FEE' | 'PERMANENT_DELEGATE' | 'FREEZE_AUTHORITY' | 'TRANSFER_HOOK' | 'MINT_AUTHORITY_ACTIVE' | 'DEFAULT_ACCOUNT_FROZEN'
  | 'NON_TRANSFERABLE' | 'CONFIDENTIAL_TRANSFER' | 'INTEREST_BEARING' | 'SCALED_UI_AMOUNT' | 'PAUSABLE' | 'MINT_CLOSE_AUTHORITY' | 'UNKNOWN_EXTENSION' | 'PERMISSIONED_BURN' | 'TOKEN_2022_PROGRAM';
export interface RiskFlag { code: RiskCode; severity: RiskSeverity; detail: string }
export interface MintRisk { mint: ParsedMint; flags: RiskFlag[]; severity: RiskSeverity; blocked: boolean; extensionNames: Token2022ExtensionName[] }

const rank: Record<RiskSeverity, number> = { info: 0, warn: 1, block: 2 };

/**
 * Pure analyzer. Default posture is fail-closed: permanent delegate, transfer hook (program set), non-transferable,
 * default-frozen accounts, pausable, permissioned burn and ANY unknown extension are BLOCKING. Freeze authority, active mint
 * authority, transfer fees, etc. are surfaced as warnings that downstream policy must accept explicitly.
 */
export function analyzeMint(mint: ParsedMint): MintRisk {
  const flags: RiskFlag[] = [];
  const add = (code: RiskCode, severity: RiskSeverity, detail: string) => flags.push({ code, severity, detail });
  if (mint.program === 'token-2022') add('TOKEN_2022_PROGRAM', 'info', 'Token-2022 program: transfer semantics may differ from SPL Token');
  if (mint.freezeAuthority) add('FREEZE_AUTHORITY', 'warn', `freeze authority ${mint.freezeAuthority} can freeze holder accounts`);
  if (mint.mintAuthority) add('MINT_AUTHORITY_ACTIVE', 'warn', `mint authority ${mint.mintAuthority} can inflate supply`);
  for (const e of mint.extensions) {
    switch (e.name) {
      case 'TransferFeeConfig': {
        const c = mint.transferFeeConfig!;
        const worst = c.older.basisPoints > c.newer.basisPoints ? c.older : c.newer;
        add('TRANSFER_FEE', 'warn', `transfer fee ${c.older.basisPoints}bps (older) / ${c.newer.basisPoints}bps (newer from epoch ${c.newer.epoch}), max ${worst.maximumFee}; recipient receives LESS than the amount sent`);
        break;
      }
      case 'PermanentDelegate':
        if (mint.permanentDelegate) add('PERMANENT_DELEGATE', 'block', `permanent delegate ${mint.permanentDelegate} can transfer/burn ANY holder balance`);
        break;
      case 'TransferHook':
        if (mint.transferHook?.programId) add('TRANSFER_HOOK', 'block', `transfer hook program ${mint.transferHook.programId} runs arbitrary code on every transfer`);
        else add('TRANSFER_HOOK', 'warn', 'transfer hook extension present with no program set (authority may set one later)');
        break;
      case 'DefaultAccountState':
        if (mint.defaultAccountState === 'frozen') add('DEFAULT_ACCOUNT_FROZEN', 'block', 'new token accounts are created FROZEN');
        break;
      case 'NonTransferable': add('NON_TRANSFERABLE', 'block', 'token is non-transferable (soulbound)'); break;
      case 'ConfidentialTransferMint': case 'ConfidentialTransferFeeConfig': add('CONFIDENTIAL_TRANSFER', 'warn', 'confidential transfers: balances may be hidden from standard RPC reads'); break;
      case 'InterestBearingConfig': add('INTEREST_BEARING', 'warn', 'UI amount accrues interest; raw amount != displayed amount'); break;
      case 'ScaledUiAmount': add('SCALED_UI_AMOUNT', 'warn', 'UI amount is scaled by a multiplier; raw amount != displayed amount'); break;
      case 'Pausable': add('PAUSABLE', 'block', 'mint can pause all transfers'); break;
      case 'PermissionedBurn': add('PERMISSIONED_BURN', 'block', 'burns are permissioned by an authority'); break;
      case 'MintCloseAuthority':
        if (mint.mintCloseAuthority) add('MINT_CLOSE_AUTHORITY', 'warn', `mint can be closed by ${mint.mintCloseAuthority}`);
        break;
      case 'Unknown': add('UNKNOWN_EXTENSION', 'block', `unknown extension type ${e.type}: cannot assess risk`); break;
      default: break; // MetadataPointer, TokenMetadata, Group*, ... informational / non-economic
    }
  }
  let severity: RiskSeverity = 'info';
  for (const f of flags) if (rank[f.severity] > rank[severity]) severity = f.severity;
  return { mint, flags, severity, blocked: severity === 'block', extensionNames: mint.extensions.map((e) => e.name).filter((n): n is Token2022ExtensionName => n !== 'Unknown') };
}

/** Mirrors TransferFee::calculate_fee: 0 if bps==0 or amount==0; else min(ceil(amount*bps/10000), maximumFee). */
export function calculateTransferFee(amount: bigint, fee: TransferFee): bigint {
  if (amount < 0n) throw new Error('negative amount');
  if (fee.basisPoints === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}
/** Fee schedule in force at `epoch` (newer applies once epoch >= newer.epoch). */
export function activeTransferFee(cfg: NonNullable<ParsedMint['transferFeeConfig']>, epoch: bigint): TransferFee { return epoch >= cfg.newer.epoch ? cfg.newer : cfg.older; }
/** Amount the recipient actually receives for a gross transfer of `amount`. */
export function netReceived(mint: ParsedMint, amount: bigint, epoch: bigint): bigint {
  if (!mint.transferFeeConfig) return amount;
  return amount - calculateTransferFee(amount, activeTransferFee(mint.transferFeeConfig, epoch));
}
