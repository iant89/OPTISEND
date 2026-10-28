import { byteCapacity, alphanumericCapacity, ECC_LEVELS } from '../src/qr/capacity.ts';
const out: Record<string, number[]> = {};
for (const e of ECC_LEVELS) { out[`byte_${e}`] = []; out[`alnum_${e}`] = []; for (let v = 1; v <= 40; v++) { out[`byte_${e}`]!.push(byteCapacity(v, e)); out[`alnum_${e}`]!.push(alphanumericCapacity(v, e)); } }
console.log(JSON.stringify(out));
