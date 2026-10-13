/** Mirrors the decision rule in SQL `request_transfer` (0002_ledger.sql): kind = 'logical' when source and destination wallet-chain accounts are identical, else 'physical'. */
export type TransferKind = 'logical' | 'physical';
export const transferKind = (srcWca: string, dstWca: string): TransferKind => (srcWca === dstWca ? 'logical' : 'physical');
/** Initial status written by request_transfer for each kind. */
export const initialStatus = (k: TransferKind) => (k === 'logical' ? 'confirmed' : 'pending_finality');
/** Destination is credited immediately only for logical transfers; physical transfers credit at confirm_transfer (finality). */
export const destinationCreditedAtRequest = (k: TransferKind) => k === 'logical';

export interface AccountRow { wca: string; wallet_id: string; nickname: string; chain_id: string; chain_name: string; finality_model: string; wallet_state: string; allocations: { bucket_id: string; exclusive: boolean; bps: number; logical_ack: boolean }[] }
/** Same pre-checks as request_transfer, so the wizard can explain a refusal before the API does. */
export function transferProblems(a: { srcBucket?: { kind: string; environment: string }; dstBucket?: { environment: string }; src?: AccountRow; dst?: AccountRow; srcBucketId?: string; dstBucketId?: string }): string[] {
  const p: string[] = [];
  if (!a.srcBucket || !a.dstBucket) return p;
  if (a.srcBucket.environment !== a.dstBucket.environment) p.push('Source and destination buckets are in different environments (paper vs live never mix).');
  if (a.srcBucket.kind === 'protected_vault') p.push('Protected vault funds cannot be transferred here: use the vault release workflow (approval + delay).');
  if (a.src && a.srcBucketId && !a.src.allocations.some((x) => x.bucket_id === a.srcBucketId)) p.push('The source wallet is not assigned to the source bucket.');
  if (a.dst && a.dstBucketId && !a.dst.allocations.some((x) => x.bucket_id === a.dstBucketId)) p.push('The destination wallet is not assigned to the destination bucket.');
  if (a.src && a.dst && a.src.wca !== a.dst.wca && a.src.chain_id !== a.dst.chain_id) p.push('Source and destination are on different chains: that is a bridge, which is not implemented. Choose accounts on the same chain.');
  return p;
}
