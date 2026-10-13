/**
 * ICS-04 packet lifecycle from the SOURCE chain's perspective.
 * A broadcast MsgTransfer / SENT packet is NOT settled: funds are escrowed (or burned) on source and may still be refunded.
 *   SENT -> RECEIVED -> ACKNOWLEDGED(success|error)
 *   SENT -> TIMED_OUT (MsgTimeout processed on source; escrow refunded)
 * RECEIVED -> TIMED_OUT is illegal (a receipt on destination forbids timeout).
 */
export type PacketState = 'SENT' | 'RECEIVED' | 'ACKNOWLEDGED' | 'TIMED_OUT';
export type AckResult = 'success' | 'error';
export interface Packet {
  sourcePort: string; sourceChannel: string; destPort: string; destChannel: string; sequence: bigint;
  timeoutHeight?: { revisionNumber: bigint; revisionHeight: bigint }; timeoutTimestampNs?: bigint;
  state: PacketState; ack?: AckResult; history: { state: PacketState; at: number }[];
}
const ALLOWED: Record<PacketState, PacketState[]> = { SENT: ['RECEIVED', 'TIMED_OUT'], RECEIVED: ['ACKNOWLEDGED'], ACKNOWLEDGED: [], TIMED_OUT: [] };

export function newPacket(p: Omit<Packet, 'state' | 'history' | 'ack'>, now: number): Packet {
  if (!p.timeoutHeight && !p.timeoutTimestampNs) throw new Error('packet must have a timeout (height or timestamp)');
  return { ...p, state: 'SENT', history: [{ state: 'SENT', at: now }] };
}
export function transition(p: Packet, to: PacketState, now: number, ack?: AckResult): Packet {
  if (!ALLOWED[p.state].includes(to)) throw new Error(`illegal IBC transition ${p.state} -> ${to}`);
  if (to === 'ACKNOWLEDGED' && !ack) throw new Error('ACKNOWLEDGED requires ack result');
  if (to !== 'ACKNOWLEDGED' && ack) throw new Error('ack only valid on ACKNOWLEDGED');
  return { ...p, state: to, ack, history: [...p.history, { state: to, at: now }] };
}
/** Idempotent event application (at-least-once relayer events). Duplicate/older events are no-ops; contradictory ones throw. */
export function applyEvent(p: Packet, ev: { type: 'recv' | 'ack' | 'timeout'; ack?: AckResult }, now: number): Packet {
  const rank: Record<PacketState, number> = { SENT: 0, RECEIVED: 1, ACKNOWLEDGED: 2, TIMED_OUT: 2 };
  if (ev.type === 'recv') return p.state === 'SENT' ? transition(p, 'RECEIVED', now) : p.state === 'TIMED_OUT' ? (() => { throw new Error('recv after timeout: inconsistent relayer data'); })() : p;
  if (ev.type === 'ack') {
    if (p.state === 'ACKNOWLEDGED') { if (p.ack !== ev.ack) throw new Error('conflicting ack'); return p; }
    if (p.state === 'TIMED_OUT') throw new Error('ack after timeout: inconsistent');
    const r = p.state === 'SENT' ? transition(p, 'RECEIVED', now) : p; // ack implies recv happened (event for recv lost)
    return transition(r, 'ACKNOWLEDGED', now, ev.ack);
  }
  if (p.state === 'TIMED_OUT') return p;
  if (rank[p.state] >= 1) throw new Error(`timeout after ${p.state}: inconsistent`);
  return transition(p, 'TIMED_OUT', now);
}
/** True when the DESTINATION chain's latest state is past the packet timeout (a timeout proof may then be submitted). */
export function isTimeoutReached(p: Packet, dest: { revisionNumber: bigint; height: bigint; timeNs: bigint }): boolean {
  if (p.timeoutHeight && (p.timeoutHeight.revisionNumber > 0n || p.timeoutHeight.revisionHeight > 0n)) {
    const t = p.timeoutHeight;
    if (dest.revisionNumber > t.revisionNumber || (dest.revisionNumber === t.revisionNumber && dest.height >= t.revisionHeight)) return true;
  }
  return !!p.timeoutTimestampNs && p.timeoutTimestampNs > 0n && dest.timeNs >= p.timeoutTimestampNs;
}
export type Settlement = 'in_flight' | 'delivered' | 'refunded';
/** Only these outcomes are economically settled for the sender. SENT/RECEIVED are in_flight - NEVER final. */
export function settlement(p: Packet): Settlement {
  if (p.state === 'ACKNOWLEDGED') return p.ack === 'success' ? 'delivered' : 'refunded';
  if (p.state === 'TIMED_OUT') return 'refunded';
  return 'in_flight';
}
export const isFinal = (p: Packet): boolean => settlement(p) !== 'in_flight';

// ---- channel validation ----
export interface ChannelInfo { state: string; ordering: string; counterparty: { port_id: string; channel_id: string }; connection_hops: string[]; version?: string; port_id?: string; channel_id?: string }
export interface ExpectedChannel { port: string; channel: string; counterpartyChannel: string; counterpartyPort?: string; connectionHops?: string[] }
export function validateChannel(info: ChannelInfo, exp: ExpectedChannel): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!/^channel-\d+$/.test(exp.channel)) reasons.push('invalid channel id syntax');
  if (info.state !== 'STATE_OPEN') reasons.push(`channel state ${info.state} != STATE_OPEN`);
  if (info.counterparty.channel_id !== exp.counterpartyChannel) reasons.push(`counterparty channel ${info.counterparty.channel_id} != ${exp.counterpartyChannel}`);
  if (info.counterparty.port_id !== (exp.counterpartyPort ?? exp.port)) reasons.push('counterparty port mismatch');
  if (info.port_id !== undefined && info.port_id !== exp.port) reasons.push('port mismatch');
  if (exp.connectionHops && JSON.stringify(exp.connectionHops) !== JSON.stringify(info.connection_hops)) reasons.push('connection hops mismatch');
  if (info.connection_hops.length !== 1) reasons.push('multi-hop/unknown connection hops not supported');
  return { valid: reasons.length === 0, reasons };
}
