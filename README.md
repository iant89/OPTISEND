# OptiSend — Phase 1: Protocol Foundation

Offline file transfer over QR codes. This phase delivers the framework-independent protocol layer that the React sender/receiver (Phases 2–3) will sit on. No runtime dependencies.

## What's here

| Path | Purpose |
|------|---------|
| `src/protocol/packet.ts` | Binary packet encode/decode with strict validation (spec §6) |
| `src/protocol/sender.ts` | Streaming hashing, lazy packet generation, manifest splitting, pass scheduling (sequential / round-robin) |
| `src/protocol/receiver.ts` | `ReceiverEngine`: dedupe, conflicts, isolation, storage-gated progress, full-file verification, reconstruction |
| `src/protocol/chunk-store.ts` | Storage interface + in-memory store (IndexedDB arrives in Phase 4) |
| `src/protocol/transport.ts`, `base45.ts` | QR framing: raw bytes or `OS:` + Base45 for text-only decoders |
| `src/protocol/filename.ts` | Untrusted file-name sanitisation |
| `src/qr/capacity.ts` | QR capacity for v1–40 × L/M/Q/H, presets, auto version selection |
| `src/crypto/` | Incremental SHA-256 (bounded memory), CRC-32 |
| `docs/PROTOCOL.md` | Normative wire format |

## Commands

```bash
npm install
npm run typecheck
npm test                 # 77 tests (node:test via tsx)
npm run verify:qr        # cross-check capacity tables against OpenCV (python3 + opencv)
node --import tsx scripts/bench.mts
```

`tests/optical-roundtrip.test.ts` renders real QR images, adds blur + noise, decodes them with OpenCV and feeds the receiver; it skips itself if python3/OpenCV are absent.

## Usage sketch

```ts
import { prepareTransfer, blobSource, frameForQr, PAYLOAD_PRESETS, maxPacketBytes,
         ReceiverEngine, MemoryChunkStore, unframeScan } from './src/protocol';

// Sender
const p = PAYLOAD_PRESETS.balanced;
const plan = await prepareTransfer(files.map(f => ({ name: f.name, mimeType: f.type, source: blobSource(f) })),
  { chunkSize: p.chunkSize, maxManifestPacketBytes: maxPacketBytes(p.version, p.ecc, p.transport) });
for (const ref of plan.pass()) showQr(frameForQr(await plan.packet(ref), p.transport));

// Receiver
const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
onScan(async (bytes, text) => { const pkt = unframeScan({ bytes, text }); if (pkt) await rx.ingest(pkt); });
```

## Notes for Phase 2–3

- Measured (Node 22): SHA-256 ≈ 127 MB/s; the receiver ingests + verifies ≈ 10,000 packets/s; duplicates cost ~5 µs each. Protocol work is negligible next to a 750 ms frame interval.
- In the optical test, OpenCV's standard detector missed ~7–10% of noisy frames that a second decoder recovered. Plan for a fallback decoder in the receiver, not just `BarcodeDetector`.
- `BarcodeDetector.rawValue` is text-only; use the `alphanumeric` transport where it is the decoder.
