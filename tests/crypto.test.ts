import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { Sha256, sha256 } from '../src/crypto/sha256.ts';
import { crc32 } from '../src/crypto/crc32.ts';
import { bytesEqual, fromHex, toHex } from '../src/crypto/bytes.ts';
import { base45Decode, base45Encode, base45Length, base45MaxBytes } from '../src/protocol/base45.ts';
import { makeBytes, nodeSha256 } from './helpers.ts';

const enc = new TextEncoder();

test('sha256: FIPS 180-4 reference vectors', () => {
  assert.equal(toHex(sha256(new Uint8Array())), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(toHex(sha256(enc.encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    toHex(sha256(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('sha256: matches node:crypto for every length 0..300 (padding boundaries)', () => {
  for (let n = 0; n <= 300; n++) {
    const b = makeBytes(n, n + 1);
    assert.ok(bytesEqual(sha256(b), nodeSha256(b)), `length ${n}`);
  }
});

test('sha256: incremental updates at arbitrary split points equal one-shot', () => {
  const data = makeBytes(5000, 99);
  const expected = nodeSha256(data);
  for (const step of [1, 3, 63, 64, 65, 127, 1000, 4999]) {
    const h = new Sha256();
    for (let o = 0; o < data.length; o += step) h.update(data.subarray(o, o + step));
    assert.ok(bytesEqual(h.digest(), expected), `step ${step}`);
  }
});

test('sha256: large input (5 MiB) matches node:crypto', () => {
  const data = makeBytes(5 * 1024 * 1024 + 17, 3);
  assert.ok(bytesEqual(sha256(data), nodeSha256(data)));
});

test('sha256: misuse is rejected', () => {
  const h = new Sha256();
  h.digest();
  assert.throws(() => h.digest());
  assert.throws(() => h.update(new Uint8Array(1)));
});

test('crc32 matches zlib', () => {
  for (const n of [0, 1, 7, 116, 1000]) {
    const b = makeBytes(n, n + 5);
    assert.equal(crc32(b), zlibCrc32(b), `length ${n}`);
  }
  const b = makeBytes(200);
  assert.equal(crc32(b, 10, 150), zlibCrc32(b.subarray(10, 150)));
});

test('hex helpers round-trip and reject junk', () => {
  const b = makeBytes(33);
  assert.ok(bytesEqual(fromHex(toHex(b)), b));
  assert.throws(() => fromHex('abc'));
  assert.throws(() => fromHex('zz'));
});

test('base45: RFC 9285 test vectors', () => {
  assert.equal(base45Encode(enc.encode('AB')), 'BB8');
  assert.equal(base45Encode(enc.encode('Hello!!')), '%69 VD92EX0');
  assert.equal(base45Encode(enc.encode('base-45')), 'UJCLQE7W581');
  assert.equal(base45Encode(enc.encode('ietf!')), 'QED8WEX0');
  assert.equal(new TextDecoder().decode(base45Decode('QED8WEX0')!), 'ietf!');
});

test('base45: round-trips arbitrary bytes of every small length', () => {
  for (let n = 0; n < 200; n++) {
    const b = makeBytes(n, n + 11);
    const s = base45Encode(b);
    assert.equal(s.length, base45Length(n));
    assert.ok(bytesEqual(base45Decode(s)!, b), `length ${n}`);
  }
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.ok(bytesEqual(base45Decode(base45Encode(all))!, all));
});

test('base45: rejects malformed input without throwing', () => {
  assert.equal(base45Decode('A'), null); // length % 3 == 1
  assert.equal(base45Decode('abc'), null); // lowercase not in alphabet
  assert.equal(base45Decode('GGW'), null); // 65535 < value  (16 + 16*45 + 32*2025 = 65536)
  assert.equal(base45Decode('::'), null); // 44 + 44*45 > 255
  assert.equal(base45Decode('ÄÄÄ'), null);
});

test('base45: capacity helpers are inverse', () => {
  for (let chars = 0; chars < 100; chars++) {
    const max = base45MaxBytes(chars);
    assert.ok(base45Length(max) <= chars);
    assert.ok(base45Length(max + 1) > chars);
  }
});
