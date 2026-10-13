/** Per-signer account_number/sequence tracker. Sequence must be reserved locally for concurrent txs and resynced on mismatch. */
export class SequenceTracker {
  private next = new Map<string, bigint>();
  /** seed from chain (auth account query). Never lowers an already-reserved sequence unless force. */
  seed(key: string, onChain: bigint, force = false): void {
    const cur = this.next.get(key);
    if (cur === undefined || force || onChain > cur) this.next.set(key, onChain);
  }
  reserve(key: string): bigint {
    const cur = this.next.get(key);
    if (cur === undefined) throw new Error(`sequence for ${key} not seeded from chain`);
    this.next.set(key, cur + 1n);
    return cur;
  }
  /** release a reservation only if it was the most recent and the tx was provably never broadcast */
  releaseUnbroadcast(key: string, seq: bigint): boolean {
    if (this.next.get(key) === seq + 1n) { this.next.set(key, seq); return true; }
    return false;
  }
  /** Handle "account sequence mismatch, expected N, got M" => resync to N. Returns expected or null if not a mismatch. */
  onBroadcastError(key: string, message: string): bigint | null {
    const m = /account sequence mismatch, expected (\d+), got (\d+)/.exec(message);
    if (!m) return null;
    const expected = BigInt(m[1]!);
    this.next.set(key, expected);
    return expected;
  }
}
