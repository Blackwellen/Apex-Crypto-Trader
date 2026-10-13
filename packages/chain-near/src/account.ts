export type NearAccountKind = 'named' | 'near-implicit' | 'eth-implicit';
export interface NearAccountResult { valid: boolean; reason?: string; kind?: NearAccountKind; isSubAccount?: boolean; parent?: string }

const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/**
 * NEAR account ID rules (nomicon): length 2..64; lowercase alphanum parts separated by single '.', '-' or '_' (no leading/trailing/consecutive separators).
 * 64 lowercase hex chars = NEAR-implicit account (ed25519 pubkey); "0x" + 40 hex = ETH-implicit (NEP-518).
 */
export function validateNearAccountId(id: string): NearAccountResult {
  if (typeof id !== 'string') return { valid: false, reason: 'not a string' };
  if (id.length < 2 || id.length > 64) return { valid: false, reason: `length ${id.length} outside 2..64` };
  if (/^[0-9a-f]{64}$/.test(id)) return { valid: true, kind: 'near-implicit', isSubAccount: false };
  if (/^0x[0-9a-f]{40}$/.test(id)) return { valid: true, kind: 'eth-implicit', isSubAccount: false };
  if (/^0x/.test(id) && id.length === 42) return { valid: false, reason: 'ETH-implicit ids must be lowercase hex' };
  if (!NAMED.test(id)) return { valid: false, reason: 'invalid characters or separator placement (lowercase a-z 0-9 and single . - _ only)' };
  const i = id.indexOf('.');
  return { valid: true, kind: 'named', isSubAccount: i >= 0, parent: i >= 0 ? id.slice(i + 1) : undefined };
}
/** Only the parent (or the account itself for top-level creation by registrar) may create a sub-account. */
export const canCreateSubAccount = (creator: string, newId: string): boolean => {
  const n = validateNearAccountId(newId);
  return n.valid && n.kind === 'named' && n.isSubAccount === true && n.parent === creator;
};
