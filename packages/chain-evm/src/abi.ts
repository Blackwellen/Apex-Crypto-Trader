// Minimal ABI encoder/decoder for the handful of calls we make (no dynamic arrays, no tuples).
import { keccakHex } from './address.ts';
import { strip0x } from './hex.ts';

export function selector(signature: string): string { return keccakHex(signature).slice(0, 10); }

export type AbiArg =
  | { t: 'address'; v: string } | { t: 'uint'; v: bigint } | { t: 'bool'; v: boolean } | { t: 'bytes'; v: string };

const word = (hex: string) => hex.padStart(64, '0');
export function encodeCall(signature: string, args: AbiArg[]): string {
  const head: string[] = []; const tail: string[] = [];
  const headSize = args.length * 32;
  for (const a of args) {
    switch (a.t) {
      case 'address': {
        const s = strip0x(a.v).toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(s)) throw new Error('bad address arg');
        head.push(word(s)); break;
      }
      case 'uint': {
        if (a.v < 0n || a.v >= 1n << 256n) throw new Error('uint256 out of range');
        head.push(word(a.v.toString(16))); break;
      }
      case 'bool': head.push(word(a.v ? '1' : '0')); break;
      case 'bytes': {
        const s = strip0x(a.v).toLowerCase();
        if (s.length % 2 || !/^[0-9a-f]*$/.test(s)) throw new Error('bad bytes arg');
        const offset = headSize + tail.join('').length / 2;
        head.push(word(offset.toString(16)));
        const len = s.length / 2;
        const padded = s.padEnd(Math.ceil(s.length / 64) * 64, '0');
        tail.push(word(len.toString(16)) + padded);
        break;
      }
    }
  }
  return selector(signature) + head.join('') + tail.join('');
}

/** Decode a return blob consisting of N static 32-byte words as uint256 values. */
export function decodeUintWords(data: string, expected: number): bigint[] {
  const s = strip0x(data);
  if (s.length < expected * 64) throw new Error(`return data too short: need ${expected} words, got ${s.length / 64}`);
  const out: bigint[] = [];
  for (let i = 0; i < expected; i++) out.push(BigInt('0x' + s.slice(i * 64, i * 64 + 64)));
  return out;
}

/** Decode revert data: Error(string) / Panic(uint256). Unknown custom errors are reported as selector only. */
export function decodeRevert(data: string | undefined): { kind: 'error' | 'panic' | 'custom' | 'empty'; message: string } {
  if (!data || data === '0x') return { kind: 'empty', message: 'execution reverted (no data)' };
  const s = strip0x(data);
  const sel = s.slice(0, 8).toLowerCase();
  if (sel === '08c379a0') {
    try {
      const len = Number(BigInt('0x' + s.slice(8 + 64, 8 + 128)));
      const hex = s.slice(8 + 128, 8 + 128 + len * 2);
      return { kind: 'error', message: new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))) };
    } catch { return { kind: 'error', message: 'Error(string) with undecodable payload' }; }
  }
  if (sel === '4e487b71') return { kind: 'panic', message: `Panic(0x${BigInt('0x' + (s.slice(8, 72) || '0')).toString(16)})` };
  return { kind: 'custom', message: `custom error selector 0x${sel}` };
}
