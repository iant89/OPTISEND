/** Browser-side harness for e2e/storage.test.ts: exposes storage + protocol to page.evaluate. */
import { IdbChunkStore, IdbSessionStore, openDatabase } from '../../src/storage/idb.ts';
import { ReceiverStorage } from '../../src/storage/persistence.ts';
import { StorageQuotaError } from '../../src/protocol/chunk-store.ts';
import { prepareTransfer } from '../../src/protocol/sender.ts';
import { bytesSource } from '../../src/protocol/source.ts';
import { toHex } from '../../src/crypto/bytes.ts';

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; }
  return b;
}

async function packets(size: number, seed: number, chunkSize = 200) {
  const sid = Uint8Array.from([seed, 2, 3, 4, 5, 6, 7, 8]);
  const plan = await prepareTransfer([{ name: `file-${seed}.bin`, mimeType: 'application/octet-stream', source: bytesSource(bytes(size, seed)) }], { chunkSize, maxManifestPacketBytes: 1000, sessionId: sid });
  const out: Uint8Array[] = [plan.manifestPackets[0]!];
  for (let i = 0; i < plan.files[0]!.chunkCount; i++) out.push(await plan.dataPacket(0, i));
  return { sid: toHex(sid), out, data: bytes(size, seed) };
}

async function readAll(storage: ReceiverStorage, sid: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of storage.engine.readFile(sid, 0)) parts.push(c.slice());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

(window as unknown as Record<string, unknown>).harness = {
  async chunkStoreBasics() {
    const db = await openDatabase('optisend-test-basics');
    const s = new IdbChunkStore(db);
    await s.put({ sessionId: 'aa', fileId: 0, chunkIndex: 0 }, bytes(10, 1));
    await s.put({ sessionId: 'aa', fileId: 0, chunkIndex: 1 }, bytes(7, 2));
    await s.put({ sessionId: 'aa', fileId: 1, chunkIndex: 0 }, bytes(5, 3));
    await s.put({ sessionId: 'bb', fileId: 0, chunkIndex: 0 }, bytes(3, 4));
    const got = await s.get({ sessionId: 'aa', fileId: 0, chunkIndex: 1 });
    const list0 = [...(await s.listChunks('aa', 0)).entries()];
    await s.deleteFile('aa', 0);
    const afterFile = [(await s.listChunks('aa', 0)).size, (await s.listChunks('aa', 1)).size];
    await s.deleteSession('aa');
    const afterSession = [(await s.listChunks('aa', 1)).size, (await s.listChunks('bb', 0)).size];
    const missing = await s.get({ sessionId: 'zz', fileId: 0, chunkIndex: 0 });
    db.close();
    return { roundTrip: !!got && eq(got, bytes(7, 2)), list0, afterFile, afterSession, missing: missing === undefined };
  },

  /** Receive part of a transfer, flush, and leave it in IndexedDB for a reload. */
  async receivePartial(dbName: string, count: number) {
    const st = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const { sid, out } = await packets(2000, 9);
    for (const p of out.slice(0, count)) await st.engine.ingest(p);
    await st.flush();
    return { durable: st.state.durable, sid, received: st.engine.snapshot()[0]?.files[0]?.receivedChunks ?? 0 };
  },

  /** After a reload: restore, finish the transfer, verify bytes; check deletion. */
  async resumeAfterReload(dbName: string) {
    const st = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const report = st.restoreReport;
    const before = st.engine.snapshot()[0]?.files[0];
    const { sid, out, data } = await packets(2000, 9);
    const results: string[] = [];
    for (const p of out) results.push((await st.engine.ingest(p)).status);
    await st.flush();
    const f = st.engine.snapshot()[0]!.files[0]!;
    const content = f.status === 'verified' ? eq(await readAll(st, sid), data) : false;
    const usage = await st.usageBySession();
    return { report, beforeReceived: before?.receivedChunks ?? 0, beforeName: before?.name ?? null, duplicates: results.filter((r) => r === 'duplicate').length, status: f.status, content, usage: usage.get(sid) ?? 0 };
  },

  async verifiedAfterReload(dbName: string) {
    const st = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const f = st.engine.snapshot()[0]?.files[0];
    const sid = st.engine.snapshot()[0]?.sessionId ?? '';
    const ok = f?.status === 'verified' ? eq(await readAll(st, sid), bytes(2000, 9)) : false;
    await st.engine.removeFile(sid, 0);
    await st.flush();
    const st2 = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const left = st2.engine.snapshot().length;
    const usage = (await st2.usageBySession()).get(sid) ?? 0;
    await st2.clearAll();
    const st3 = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    return { status: f?.status ?? null, ok, leftAfterDelete: left, usageAfterDelete: usage, afterClear: st3.engine.sessionIds().length };
  },

  /** With a tiny quota: writes fail as storage errors, nothing is counted, then succeed once space exists. */
  async quotaRun(dbName: string) {
    const st = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const { out } = await packets(400_000, 11, 2800);
    const statuses: Record<string, number> = {};
    let firstError = '';
    for (const p of out) {
      const r = await st.engine.ingest(p);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.status === 'storage-error' && !firstError) firstError = r.detail;
    }
    const f = st.engine.snapshot()[0]?.files[0];
    return { statuses, firstError, received: f?.receivedChunks ?? 0, storedBytes: f?.storedBytes ?? 0, chunkCount: f?.chunkCount ?? 0, isQuotaClass: firstError === new StorageQuotaError('Browser storage is full').message };
  },

  async quotaRetry(dbName: string) {
    const st = await ReceiverStorage.open({ dbName, debounceMs: 50 });
    const { sid, out, data } = await packets(400_000, 11, 2800);
    for (const p of out) await st.engine.ingest(p);
    const f = st.engine.snapshot()[0]!.files[0]!;
    return { status: f.status, ok: f.status === 'verified' ? eq(await readAll(st, sid), data) : false };
  },

  async sessionStoreRaw(dbName: string) {
    const db = await openDatabase(dbName);
    const all = await new IdbSessionStore(db).loadAll();
    db.close();
    return all.map((s) => ({ id: s.id, files: s.files.length, bitmapIsU8: s.files[0]?.bitmap instanceof Uint8Array, fpIsU32: s.files[0]?.fingerprints instanceof Uint32Array }));
  },
};
