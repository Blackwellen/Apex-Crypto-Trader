/** Mirrors apply_waterfall() in packages/db (0004): deficit first, then tax provision, then integer bps splits; the remainder goes to reinvest. PREVIEW only. */
export interface WaterfallPolicy { reinvestBps: number; vaultBps: number; crossBucketBps: number; reserveBps: number; taxProvisionBps: number }
export function waterfallTotalBps(p: Pick<WaterfallPolicy, 'reinvestBps' | 'vaultBps' | 'crossBucketBps' | 'reserveBps'>) { return p.reinvestBps + p.vaultBps + p.crossBucketBps + p.reserveBps; }
export function waterfallPreview(grossProfit: bigint, deficit: bigint, p: WaterfallPolicy) {
  const def = deficit < grossProfit ? deficit : grossProfit;
  const eligible = grossProfit - def;
  const tax = (eligible * BigInt(p.taxProvisionBps)) / 10000n;
  const base = eligible - tax;
  const vault = (base * BigInt(p.vaultBps)) / 10000n, cross = (base * BigInt(p.crossBucketBps)) / 10000n, reserve = (base * BigInt(p.reserveBps)) / 10000n;
  const reinvest = eligible - tax - vault - cross - reserve;
  return { gross: grossProfit, deficitRecovered: def, eligible, tax, vault, cross, reserve, reinvest, sums: tax + vault + cross + reserve + reinvest === eligible };
}
