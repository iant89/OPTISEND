// Quick throughput check: node --import tsx scripts/bench.mts
import { sha256 } from '../src/crypto/sha256.ts';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { ReceiverEngine } from '../src/protocol/receiver.ts';
import { prepareTransfer } from '../src/protocol/sender.ts';
import { bytesSource } from '../src/protocol/source.ts';
import { PAYLOAD_PRESETS } from '../src/qr/capacity.ts';

const big = new Uint8Array(64 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
let t = performance.now();
sha256(big);
const ms = performance.now() - t;
console.log(`SHA-256: ${(64 / (ms / 1000)).toFixed(0)} MB/s`);

const data = big.subarray(0, 4 * 1024 * 1024);
const preset = PAYLOAD_PRESETS['high-throughput'];
const plan = await prepareTransfer([{ name: 'x', source: bytesSource(data) }], { chunkSize: preset.chunkSize, maxManifestPacketBytes: 2953 });
const packets: Uint8Array[] = [];
t = performance.now();
for (let i = 0; i < plan.files[0]!.chunkCount; i++) packets.push(await plan.dataPacket(0, i));
console.log(`Sender: ${packets.length} packets in ${(performance.now() - t).toFixed(0)} ms`);
const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
t = performance.now();
for (const p of packets) await rx.ingest(p);
console.log(`Receiver: ingest+verify ${packets.length} packets in ${(performance.now() - t).toFixed(0)} ms (${rx.snapshot()[0]!.files[0]!.status})`);
t = performance.now();
for (const p of packets) await rx.ingest(p);
console.log(`Receiver: ${packets.length} duplicates in ${(performance.now() - t).toFixed(0)} ms`);
