/**
 * OptiSend wire protocol v1 — constants.
 * See docs/PROTOCOL.md for the normative byte layout.
 * All multi-byte integers are big-endian (network byte order).
 */

/** "OS" — first two bytes of every packet. */
export const MAGIC = 0x4f53;
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS: readonly number[] = [1];

export const PacketType = {
  Manifest: 0x01,
  Data: 0x02,
  /** Reserved for forward error correction (spec §10). Rejected by v1 receivers. */
  Parity: 0x03,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const HashAlgorithm = {
  Sha256: 0x01,
} as const;
export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

/**
 * Header flag bits. v1 defines none; any set bit is rejected so that a v1
 * receiver never misinterprets a packet that relies on a future extension.
 * Reserved: bit 0 = payload compressed.
 */
export const Flags = {
  None: 0x00,
  ReservedCompressed: 0x01,
} as const;
export const DEFINED_FLAGS_MASK = 0x00;

export const SESSION_ID_BYTES = 8;
export const HASH_BYTES = 32;
export const CRC_BYTES = 4;

/** magic(2) version(1) type(1) flags(1) hashAlg(1) headerLen(2) payloadLen(2) sessionId(8) */
export const COMMON_HEADER_BYTES = 18;

/** Common header + fileId(2) fileSize(8) chunkSize(4) chunkCount(4) chunkIndex(4) startOffset(8) fileHash(32) chunkHash(32) + CRC(4). */
export const DATA_HEADER_BYTES = COMMON_HEADER_BYTES + 2 + 8 + 4 + 4 + 4 + 8 + HASH_BYTES + HASH_BYTES + CRC_BYTES; // 116

/** Common header + partIndex(2) partCount(2) fileCount(2) entryCount(2), entries…, CRC(4). */
export const MANIFEST_FIXED_BYTES = COMMON_HEADER_BYTES + 2 + 2 + 2 + 2 + CRC_BYTES; // 30

/** fileId(2) fileSize(8) chunkSize(4) chunkCount(4) fileHash(32) mimeLen(1) nameLen(2) — excluding variable mime/name bytes. */
export const MANIFEST_ENTRY_FIXED_BYTES = 2 + 8 + 4 + 4 + HASH_BYTES + 1 + 2; // 53

/** Largest value representable in the u16 payloadLength field. */
export const MAX_WIRE_PAYLOAD = 0xffff;

/** Absolute (wire-format) ceilings. Configurable receiver limits sit below these. */
export const MAX_NAME_BYTES = 255;
export const MAX_MIME_BYTES = 127;
