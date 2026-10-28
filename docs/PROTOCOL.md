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
| 3      | 1    | type            | `0x01` manifest, `0x02` data, `0x03` repair (§5a; receivers that predate it reject it as an unsupported type) |
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

## 5a. Repair packet (type 0x03) — fountain code, header is exactly 116 bytes

A sender may follow the first pass of data packets with **repair symbols**: systematic fountain coding over GF(2). Each repair symbol is the XOR of a pseudo-random subset of one source block's chunks. A receiver missing *m* chunks of a block rebuilds them from any *m* repair symbols of that block (occasionally a few more), whichever symbols those are. Data and manifest packets are unchanged, so a receiver that predates repair packets still receives everything sent as data.

| Offset | Size | Field        |
|-------:|-----:|--------------|
| 0      | 18   | common header |
| 18     | 2    | fileId       |
| 20     | 8    | fileSize     |
| 28     | 4    | chunkSize    |
| 32     | 4    | chunkCount   |
| 36     | 4    | blockIndex   |
| 40     | 4    | blockSize    | nominal chunks per source block (1–1024) |
| 44     | 4    | symbolId     | any u32; a sender never repeats one for a block |
| 48     | 32   | fileHash     |
| 80     | 32   | payloadHash  | SHA-256 of this payload |
| 112    | 4    | headerCrc32  |

Like data packets, repair packets are self-describing: a receiver can create the file record from one.

**Blocks.** Chunk *i* belongs to block ⌊*i* / blockSize⌋. A block covers chunks [blockIndex × blockSize, min((blockIndex + 1) × blockSize, chunkCount)), so *n* = its chunk count. Senders choose blockSize = ⌈chunkCount / ⌈chunkCount / 256⌉⌉ (blocks of at most 256 chunks, as equal as possible); a file's blockSize must not change. Receivers enforce 1 ≤ blockSize ≤ 1024 and blockIndex < ⌈chunkCount / blockSize⌉.

**Payload.** Its length L is the length of the block's first chunk (`min(chunkSize, fileSize − blockIndex × blockSize × chunkSize)`). The payload is the XOR of the selected chunks, each zero-padded to L.

**Coefficients.** Which of the block's *n* chunks symbol `symbolId` combines is a bitset: bit *j* of word ⌊*j*/32⌋ selects chunk *j*. All arithmetic is unsigned 32-bit, wrapping:

```
fmix32(h):  h ^= h >>> 16;  h *= 0x85EBCA6B;  h ^= h >>> 13;  h *= 0xC2B2AE35;  h ^= h >>> 16
base      = fmix32(fmix32(blockIndex XOR 0x9E3779B9) XOR symbolId)
word w    = fmix32(base + (w + 1) × 0x9E3779B9)          for w = 0 … ⌈n/32⌉ − 1
```

Bits at positions ≥ *n* are cleared. If no bit is set, bit (symbolId mod *n*) is set. Each chunk is included with probability ½. The generator must be non-linear over GF(2): a linear one (such as xorshift) confines every symbol of a block to a 32-dimensional subspace, so blocks missing more than 32 chunks could never be rebuilt.

**Receiving.**
1. Reject a symbol whose payload does not match `payloadHash` (`repair-hash-mismatch`) before keeping anything, so a damaged symbol cannot poison a solve.
2. Ignore symbols for verified files, for blocks with nothing missing, and duplicates (same block and symbolId).
3. When a block holds at least as many symbols as it has missing chunks, solve: XOR the known chunks out of each symbol, then Gauss–Jordan eliminate over the missing ones. If the symbols do not determine every missing chunk yet, wait for more.
4. A rebuilt chunk is truncated to its length (any padding must decode to zero bytes) and stored like a received chunk. Only after the write succeeds is it counted. Its fingerprint is computed from its bytes, and the file is `verified` only when the full-file SHA-256 matches, as for data.

The reference receiver keeps at most (missing + 8) symbols per block, dropping the oldest, and at most 64 MiB of symbols in total. Symbols live in memory only, and a reload collects new ones.

**Sending.** The reference sender sends pass 1 as data packets. Each later pass has the same frames, but the frame that carried chunk *c* carries a repair symbol of block (*c* mod blockCount), with symbolId = (pass − 2) × ⌈chunkCount / blockCount⌉ + ⌊*c* / blockCount⌋. Consecutive frames therefore cycle through the blocks, and symbol ids never repeat.

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

Receivers reject unknown versions, packet types and flag bits rather than guessing. A future extension that adds compression or signed manifests must bump the version or define a flag/type that earlier receivers reject cleanly. Repair packets (§5a) did this: they define type `0x03`, which receivers built before them reject as an unsupported type while still accepting the data packets of the same transfer.
