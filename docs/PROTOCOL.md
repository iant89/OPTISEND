# OptiSend Wire Protocol — v1

Status: implemented in `src/protocol/` (Phase 1). This document is normative for protocol version 1.

## 1. Conventions

- All integers are **unsigned, big-endian**.
- `u64` fields must be ≤ 2^53 − 1 (JavaScript safe integer); larger values are rejected.
- Byte ranges are zero-based with an **exclusive** end: `[start, end)`, `end − start = length`.
- Hashes are SHA-256 (32 bytes). Header checksums are CRC-32 (IEEE, as zlib/PNG).

## 2. Packet framing

Every QR code carries exactly one packet:

```
[ header : headerLength bytes ][ payload : payloadLength bytes ]
```

The **last 4 bytes of every header** are a CRC-32 of all preceding header bytes. The CRC catches accidental header damage (e.g. a lossy decoder); data payloads are protected separately by their SHA-256 chunk hash.

`headerLength + payloadLength` must equal the packet length exactly.

## 3. Common header (18 bytes)

| Offset | Size | Field           | Notes |
|-------:|-----:|-----------------|-------|
| 0      | 2    | magic           | `0x4F53` (`"OS"`) |
| 2      | 1    | version         | `1` |
| 3      | 1    | type            | `0x01` manifest, `0x02` data, `0x03` parity (reserved; rejected by v1) |
| 4      | 1    | flags           | No flags defined in v1. **Any set bit is rejected.** Bit 0 reserved for "payload compressed". |
| 5      | 1    | hashAlgorithm   | `0x01` = SHA-256 (only value in v1) |
| 6      | 2    | headerLength    | Includes the trailing CRC |
| 8      | 2    | payloadLength   | `0` for manifests |
| 10     | 8    | sessionId       | Random per transfer |

## 4. Data packet (type 0x02) — header is exactly 116 bytes

| Offset | Size | Field        |
|-------:|-----:|--------------|
| 0      | 18   | common header |
| 18     | 2    | fileId       |
| 20     | 8    | fileSize     |
| 28     | 4    | chunkSize    | nominal payload size for this file |
| 32     | 4    | chunkCount   |
| 36     | 4    | chunkIndex   |
| 40     | 8    | startOffset  |
| 48     | 32   | fileHash     | SHA-256 of the complete file |
| 80     | 32   | chunkHash    | SHA-256 of this payload |
| 112    | 4    | headerCrc32  |

Payload: the chunk bytes. `endOffset` is not transmitted; it is `startOffset + payloadLength`.

Every data packet is **self-describing**: a receiver can create a file record, place and validate the chunk, and verify the whole file without ever seeing a manifest. Only the name and media type require the manifest.

### Geometry rules (receiver must enforce)

```
chunkCount   = fileSize == 0 ? 1 : ceil(fileSize / chunkSize)
chunkIndex   < chunkCount
startOffset  = chunkIndex × chunkSize
payloadLength = min(chunkSize, fileSize − startOffset)
startOffset + payloadLength ≤ fileSize
```

An empty file is sent as a single zero-length chunk.

## 5. Manifest packet (type 0x01) — header-only, payloadLength = 0

| Offset | Size | Field       |
|-------:|-----:|-------------|
| 0      | 18   | common header |
| 18     | 2    | partIndex   |
| 20     | 2    | partCount   |
| 22     | 2    | fileCount   | total files in the session |
| 24     | 2    | entryCount  | entries in this part (≥ 1) |
| 26     | …    | entries     |
| end−4  | 4    | headerCrc32 |

Entry:

| Size | Field |
|-----:|-------|
| 2    | fileId (< fileCount, unique) |
| 8    | fileSize |
| 4    | chunkSize |
| 4    | chunkCount |
| 32   | fileHash |
| 1    | mimeLength (≤ 127) |
| n    | mimeType (UTF-8, may be empty) |
| 2    | nameLength (1–255) |
| n    | name (strict UTF-8) |

A session's manifest may be split into several parts; each part is independently valid. Senders pack entries greedily up to the QR packet budget; an entry that cannot fit alone becomes its own (larger) part.

## 6. Receiver acceptance rules

Rejected outright (structural): bad magic, unsupported version/type/flags/hash algorithm, length mismatch, wrong header length for the type, CRC failure, any geometry violation, invalid UTF-8, limits exceeded.

Then, for data packets:

1. **Known chunk, same declared hash** → duplicate; ignored *without hashing*.
2. **Known chunk, different declared hash** → conflict; stored data kept, conflict counted.
3. **Metadata differs** from what is already known for `(session, fileId)` (size, chunk size, count, file hash) → conflict; refused.
4. Otherwise compute SHA-256 of the payload; mismatch → rejected (`chunk-hash-mismatch`). No state is created for a corrupt first packet.
5. Write to storage. **Only after the write succeeds** is the chunk marked received and its bytes counted.
6. When all chunks are present, stream them in order through SHA-256; only a match with `fileHash` sets the file to `verified`. A missing/short chunk in storage re-opens it for retransmission; a mismatch sets `hash-mismatch`.

Manifests are applied atomically: if any entry conflicts with known state, nothing from that packet is applied.

Storage keys are always `sessionId + fileId + chunkIndex`. File names are never keys and are sanitised before display/download.

## 7. Default limits (configurable, enforced before allocation)

| Limit | Default |
|-------|---------|
| maxFileSize | 8 GiB |
| maxChunkCount | 16,777,216 |
| maxHeaderLength | 4,096 |
| maxPayloadLength | 4,096 |
| maxNameBytes / maxMimeBytes | 255 / 127 |
| maxFilesPerSession | 1,024 |
| maxActiveSessions | 4 (fully verified sessions are evicted from memory to make room) |
| maxIncompleteFiles | 64 |

## 8. QR transport

| Transport | QR mode | Content | Use when |
|-----------|---------|---------|----------|
| `byte` | Byte | raw packet | decoder exposes raw bytes (e.g. jsQR `binaryData`) |
| `alphanumeric` | Alphanumeric | `"OS:" + Base45(packet)` (RFC 9285) | decoder only returns text (e.g. `BarcodeDetector.rawValue`) — ~3% less capacity |

`unframeScan()` accepts raw bytes, text, or both, and recognises either framing (plus a best-effort Latin-1 recovery for byte-mode content returned as text). Lossy decoding can only cause rejection, never bad data.

## 9. Capacity & presets

Capacity is computed from the ISO/IEC 18004 block tables and verified against OpenCV's encoder for all 320 (version × ECC × mode) combinations (`npm run verify:qr`). Data-packet overhead is 116 bytes.

| Preset | QR | Byte capacity | Chunk payload | Payload efficiency |
|--------|----|--------------:|--------------:|-----------:|
| Conservative | v15-M | 412 | 296 | 72% |
| Balanced | v25-M | 997 | 881 | 88% |
| High throughput | v40-L | 2,953 | 2,837 | 96% |

These are starting points; practical limits must come from device calibration (spec §5.3).

## 10. Versioning

Receivers reject unknown versions, packet types and flag bits rather than guessing. A future version that adds compression, parity packets (FEC) or signed manifests must bump the version or define the flag/type and be rejected cleanly by v1 receivers.
