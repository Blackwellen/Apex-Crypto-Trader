export const SESSION_COOKIE = 'apex_session';
export const API_URL = process.env.APEX_API_URL ?? 'http://127.0.0.1:4000';
/** Only these top-level API prefixes are reachable through the BFF proxy. */
export const PROXY_ALLOW = /^v1\/(workspaces|overview|portfolios|buckets|wallets|chain-registry|chains|strategies|positions|orders|trades|risk|fees|analytics|targets|compounding|allocations|alerts|jobs|audit|assets|baskets|commands|stream|research|treasury|market|intelligence|settings|capital)(\/|$)/;
