import test from 'node:test';
import assert from 'node:assert/strict';
import { toChecksumAddress, validateEvmAddress, keccakHex } from '../src/index.ts';

// EIP-55 official test vectors
const CHECKSUMMED = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];
const ALLCAPS = ['0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D'];
const ALLLOWER = ['0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26'];

test('keccak256("") known vector', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});
test('EIP-55 vectors checksum correctly', () => {
  for (const a of CHECKSUMMED) assert.equal(toChecksumAddress(a.toLowerCase()), a);
  for (const a of ALLCAPS) assert.equal(toChecksumAddress(a), a);
  for (const a of ALLLOWER) assert.equal(toChecksumAddress(a), a);
});
test('valid checksummed / uniform-case addresses accepted', () => {
  for (const a of CHECKSUMMED) { const r = validateEvmAddress(a); assert.ok(r.valid); assert.equal(r.checksummed, true); }
  const r = validateEvmAddress(ALLLOWER[0]!.toLowerCase()); assert.ok(r.valid); assert.equal(r.checksummed, false); assert.equal(r.normalized, toChecksumAddress(ALLLOWER[0]!));
});
test('bad checksum is rejected (single flipped case)', () => {
  const a = CHECKSUMMED[0]!; const i = 2 + a.slice(2).search(/[a-f]/i);
  const flipped = a.slice(0, i) + (a[i] === a[i]!.toUpperCase() ? a[i]!.toLowerCase() : a[i]!.toUpperCase()) + a.slice(i + 1);
  const r = validateEvmAddress(flipped); assert.equal(r.valid, false); assert.match(r.reason!, /checksum/);
});
test('structural rejections', () => {
  assert.equal(validateEvmAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').valid, false);
  assert.equal(validateEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA').valid, false);
  assert.equal(validateEvmAddress('0x' + 'g'.repeat(40)).valid, false);
  assert.equal(validateEvmAddress('0x' + 'a'.repeat(41)).valid, false);
});
test('requireChecksum and rejectZero options', () => {
  assert.equal(validateEvmAddress(ALLLOWER[0]!, { requireChecksum: true }).valid, false);
  assert.equal(validateEvmAddress(CHECKSUMMED[0]!, { requireChecksum: true }).valid, true);
  assert.equal(validateEvmAddress('0x' + '0'.repeat(40), { rejectZero: true }).valid, false);
  assert.equal(validateEvmAddress('0x' + '0'.repeat(40)).isZero, true);
});
