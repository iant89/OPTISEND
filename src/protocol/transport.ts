/**
 * QR transport framing — how a packet's bytes become QR content and back.
 *
 *  - 'byte'         : raw packet bytes in QR byte mode. Most efficient, but
 *                     requires a decoder that exposes raw bytes (e.g. jsQR's
 *                     `binaryData`). Text-only decoders may corrupt bytes.
 *  - 'alphanumeric' : "OS:" + Base45(packet) in QR alphanumeric mode. ~3%
 *                     less capacity, but survives any decoder that returns text.
 *
 * Either way the receiver relies on CRC-32 + SHA-256 to catch corruption, so
 * a lossy decode can only ever cause a rejection, never bad data.
 */

import { base45Decode, base45Encode, base45Length, base45MaxBytes } from './base45.ts';
import { MAGIC } from './constants.ts';

export type QrTransport = 'byte' | 'alphanumeric';

export const BASE45_PREFIX = 'OS:';

export type QrContent = { mode: 'byte'; bytes: Uint8Array } | { mode: 'alphanumeric'; text: string };

export function frameForQr(packet: Uint8Array, transport: QrTransport): QrContent {
  return transport === 'byte' ? { mode: 'byte', bytes: packet } : { mode: 'alphanumeric', text: BASE45_PREFIX + base45Encode(packet) };
}

/** Number of QR "characters" a packet occupies: bytes for byte mode, chars for alphanumeric. */
export function framedLength(packetBytes: number, transport: QrTransport): number {
  return transport === 'byte' ? packetBytes : BASE45_PREFIX.length + base45Length(packetBytes);
}

/** Largest packet that fits a QR whose capacity is `capacity` (bytes or alphanumeric chars). */
export function maxPacketForCapacity(capacity: number, transport: QrTransport): number {
  return transport === 'byte' ? capacity : base45MaxBytes(capacity - BASE45_PREFIX.length);
}

const MAGIC_HI = MAGIC >> 8;
const MAGIC_LO = MAGIC & 0xff;

/**
 * Recover packet bytes from whatever a QR decoder returned. Accepts raw bytes,
 * text, or both; returns null if the content is not an OptiSend frame.
 */
export function unframeScan(scan: { bytes?: Uint8Array | ArrayLike<number> | null; text?: string | null }): Uint8Array | null {
  const text = scan.text ?? null;
  if (text !== null && text.startsWith(BASE45_PREFIX)) {
    return base45Decode(text.slice(BASE45_PREFIX.length));
  }
  if (scan.bytes != null) {
    const b = scan.bytes instanceof Uint8Array ? scan.bytes : Uint8Array.from(scan.bytes);
    // Some decoders return alphanumeric text as bytes. "OS:" shares the magic's
    // first two bytes, but a binary packet's third byte is the version (never ':').
    if (b.length >= 3 && b[0] === 0x4f && b[1] === 0x53 && b[2] === 0x3a) {
      let s = '';
      for (let i = BASE45_PREFIX.length; i < b.length; i++) s += String.fromCharCode(b[i]!);
      return base45Decode(s);
    }
    if (b.length >= 2 && b[0] === MAGIC_HI && b[1] === MAGIC_LO) return b;
  }
  // Text-only decoder given byte-mode content: best-effort Latin-1 recovery.
  // Any lossy mapping will be caught by the CRC / SHA-256 checks downstream.
  if (text !== null && text.length >= 2 && text.charCodeAt(0) === MAGIC_HI && text.charCodeAt(1) === MAGIC_LO) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 0xff) return null;
      out[i] = c;
    }
    return out;
  }
  return null;
}
