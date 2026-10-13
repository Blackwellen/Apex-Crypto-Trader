export const FCA_CRYPTO_URL = 'https://www.fca.org.uk/firms/cryptoassets';
export const FCA_REGISTER_URL = 'https://register.fca.org.uk/s/';
export interface VenueRecord {
  id: string; name: string; kind: 'public-market-data' | 'synthetic-paper';
  ukAvailability: 'UNVERIFIED'; ukAvailabilityEvidence: string[];
  capabilities: Record<string, 'READ_ONLY' | 'UNSUPPORTED' | 'SYNTHETIC' | 'PENDING'>;
  docs: string[]; liveTradingCode: false; verifiedAt: string; evidenceRef?: string;
}
/** UK availability is ALWAYS 'UNVERIFIED' here. A human must verify against the venue's UK terms and the FCA register/rules. */
export const venueRecords: VenueRecord[] = [
  {
    id: 'coinbase-advanced-public', name: 'Coinbase Advanced Trade (public market data only)', kind: 'public-market-data',
    ukAvailability: 'UNVERIFIED', ukAvailabilityEvidence: [FCA_CRYPTO_URL, FCA_REGISTER_URL],
    capabilities: { listMarkets: 'READ_ONLY', getOrderBook: 'READ_ONLY', level2Stream: 'PENDING', placeOrder: 'UNSUPPORTED', balances: 'UNSUPPORTED', withdraw: 'UNSUPPORTED' },
    docs: ['https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api', 'https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels'],
    liveTradingCode: false, verifiedAt: '2026-10-13', evidenceRef: 'docs/evidence/chains-b-live-reads.md#coinbase',
  },
  {
    id: 'paper-synthetic', name: 'Paper venue (SYNTHETIC)', kind: 'synthetic-paper', ukAvailability: 'UNVERIFIED', ukAvailabilityEvidence: [],
    capabilities: { listMarkets: 'SYNTHETIC', getOrderBook: 'SYNTHETIC', placeOrder: 'UNSUPPORTED', placePaperOrder: 'SYNTHETIC' },
    docs: [], liveTradingCode: false, verifiedAt: '2026-10-13',
  },
];
