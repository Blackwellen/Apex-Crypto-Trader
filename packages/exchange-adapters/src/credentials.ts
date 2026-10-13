/** Credential scope validation and secret redaction. Pure functions. FAIL CLOSED: unknown permission => reject. */
export type PermissionsInput = Record<string, unknown> | string[] | undefined | null;
export interface ScopeResult { ok: boolean; scope: 'read_only' | 'trade' | 'rejected'; violations: string[]; unrecognised: string[] }

const FORBIDDEN = /(withdraw|transfer|send|payout|payment|deposit_address|address_book|whitelist|universal|internal|margin|futures|derivativ|admin|manage|delete|create_api|sub_?account|convert)/i;
const READ = /^(view|read|reading|read_?only|enable_?reading|can_?view|get|list|account:read|wallet:[a-z_:]*:read|user:read|market_?data)$|(^|[:_.-])(read|view)$/i;
const TRADE = /^(trade|trading|enable_?spot_?trading|spot_?trade|can_?trade|orders?:(create|cancel))$|wallet:(buys|sells|orders):create|(^|[:_.-])trade$/i;

export interface ScopeOptions { allowTrade?: boolean }
/**
 * Accepts either a flag object ({ enableWithdrawals: false, enableReading: true, ... } - Binance style / generic)
 * or a list of permission strings (["view","trade","transfer"] / ["wallet:accounts:read", ...] - Coinbase style).
 * Rejects ANY withdrawal/transfer-class permission even if flagged false-by-name is irrelevant: a flag is a permission only when TRUE.
 */
export function validateCredentialScope(perms: PermissionsInput, opts: ScopeOptions = {}): ScopeResult {
  const violations: string[] = []; const unrecognised: string[] = [];
  let sawTrade = false, sawRead = false;
  if (perms === undefined || perms === null) return { ok: false, scope: 'rejected', violations: ['permissions missing (fail closed)'], unrecognised };
  const granted: string[] = [];
  if (Array.isArray(perms)) {
    for (const p of perms) { if (typeof p !== 'string') { unrecognised.push(String(p)); continue; } granted.push(p); }
  } else if (typeof perms === 'object') {
    for (const [k, v] of Object.entries(perms)) {
      if (typeof v === 'boolean') { if (v) granted.push(k); }
      else if (typeof v === 'string') { if (!/^(false|0|no|none|disabled)$/i.test(v)) granted.push(/^(true|1|yes|enabled)$/i.test(v) ? k : `${k}:${v}`); }
      else if (Array.isArray(v)) { for (const x of v) if (typeof x === 'string') granted.push(x); else unrecognised.push(`${k}[]`); }
      else if (typeof v === 'number') { if (v !== 0) granted.push(k); }
      else if (v === null || v === undefined) { /* not granted */ }
      else unrecognised.push(k); // nested objects: cannot reason about them
    }
  } else return { ok: false, scope: 'rejected', violations: ['permissions have unsupported shape'], unrecognised };

  for (const g of granted) {
    if (FORBIDDEN.test(g)) violations.push(`forbidden permission granted: ${g}`);
    else if (TRADE.test(g)) { sawTrade = true; }
    else if (READ.test(g)) { sawRead = true; }
    else unrecognised.push(g);
  }
  if (sawTrade && !opts.allowTrade) violations.push('trade permission present but trading scope not authorised');
  for (const u of unrecognised) violations.push(`unrecognised permission '${u}' (fail closed)`);
  if (!sawRead && !sawTrade && violations.length === 0) violations.push('no recognisable read permission');
  const ok = violations.length === 0;
  return { ok, scope: ok ? (sawTrade ? 'trade' : 'read_only') : 'rejected', violations, unrecognised };
}

// ---------- redaction ----------
const SENSITIVE_KEY = /(secret|private[_-]?key|passphrase|password|token|api[_-]?key|apikey|authorization|signature|jwt|cb-access|x-mbx|credential|seed|mnemonic)/i;
export function redactApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '[REDACTED]';
  return `${key.slice(0, 4)}…${key.slice(-2)} (len ${key.length})`;
}
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/organizations\/[0-9a-f-]{8,}\/apiKeys\/[0-9a-f-]{8,}/gi, 'organizations/[REDACTED]/apiKeys/[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]'],
  [/([?&](?:api[_-]?key|signature|secret|token|apikey)=)[^&\s]+/gi, '$1[REDACTED]'],
];
export function redactString(s: string): string { return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s); }
export function redactSecrets<T>(v: T, depth = 0): T {
  if (depth > 12) return '[REDACTED depth]' as unknown as T;
  if (typeof v === 'string') return redactString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactSecrets(x, depth + 1);
    return out as T;
  }
  return v;
}
export const redactHeaders = (h: Record<string, string>): Record<string, string> => redactSecrets(h);
