/**
 * Decode a /tmp/shim.log capture produced by shim.c.
 *
 * Log format per line:
 *   OPEN /dev/ttyS3 fd=12
 *   W <count> <hex...>
 *   R <count> <hex...>
 *   CLOSE fd=12
 *
 * Output: separate TX (host->chip) and RX (chip->host) decoded streams,
 * same style as parseStrace.ts.
 *
 * Usage:
 *   tsx src/wirepas/parseShim.ts <shim.log>
 *   node dist/wirepas/parseShim.js <shim.log>
 */

import * as fs from 'fs';
import { decodeStream } from './slip';
import { decodePrimitive, parseDsapDataRx, PRIM, PRIM_NAME } from './frame';

const path = process.argv[2];
if (!path) { console.error('usage: parseShim.ts <shim.log>'); process.exit(2); }

const text = fs.readFileSync(path, 'utf8');
const tx: Buffer[] = [];
const rx: Buffer[] = [];
let opens = 0, closes = 0;

for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  if (line.startsWith('OPEN'))  { opens++;  console.log(`# ${line}`); continue; }
  if (line.startsWith('CLOSE')) { closes++; console.log(`# ${line}`); continue; }
  const m = line.match(/^([WR])\s+(\d+)\s+([0-9a-fA-F]*)$/);
  if (!m) continue;
  const dir = m[1];
  const buf = Buffer.from(m[3], 'hex');
  (dir === 'W' ? tx : rx).push(buf);
}

console.log(`# opens=${opens} closes=${closes}  TX bytes=${tx.reduce((a,b)=>a+b.length,0)}  RX bytes=${rx.reduce((a,b)=>a+b.length,0)}`);
console.log('');

function dump(label: string, chunks: Buffer[]): void {
  console.log(`========== ${label} ==========`);
  const all = Buffer.concat(chunks);
  const { frames, leftover } = decodeStream(all);
  console.log(`# ${frames.length} frame(s), leftover ${leftover.length}`);
  for (let n = 0; n < frames.length; n++) {
    const f = frames[n];
    const prim = decodePrimitive(f.payload);
    const crc  = f.crcOk ? 'ok ' : 'BAD';
    if (!prim) { console.log(`  #${String(n).padStart(3)}  CRC=${crc}  <truncated>`); continue; }
    const name = (PRIM_NAME[prim.primitive] ?? `0x${prim.primitive.toString(16)}`).padEnd(28);
    console.log(`  #${String(n).padStart(3)}  CRC=${crc}  ${name}  fid=${prim.frameId.toString(16).padStart(2,'0')}  len=${String(prim.length).padStart(3)}  ${prim.payload.toString('hex')}`);

    if (prim.primitive === PRIM.DSAP_DATA_TX_REQ && prim.payload.length >= 11) {
      const pdu = prim.payload.readUInt16LE(0);
      const dst = prim.payload.readUInt32LE(3);
      const apduLen = prim.payload[10];
      const apdu = prim.payload.subarray(11, 11 + apduLen);
      console.log(`         └── TX  pdu=0x${pdu.toString(16).padStart(4,'0')} src_ep=${prim.payload[2]} dst=0x${dst.toString(16).padStart(8,'0')} dst_ep=${prim.payload[7]} qos=${prim.payload[8]} opts=0x${prim.payload[9].toString(16).padStart(2,'0')} apdu(${apduLen})=${apdu.toString('hex')}`);
    } else if (prim.primitive === PRIM.DSAP_DATA_RX_INDICATION) {
      const ind = parseDsapDataRx(prim.payload);
      if (ind) {
        console.log(`         └── RX  src=0x${ind.srcAddress.toString(16).padStart(8,'0')} src_ep=${ind.srcEndpoint} dst=0x${ind.dstAddress.toString(16).padStart(8,'0')} dst_ep=${ind.dstEndpoint} hops=${ind.hopCount} t=${ind.travelTimeMs}ms apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}` + (ind.moreQueued ? ' [MORE]' : ''));
      }
    }
  }
}

dump('TX (host -> chip)', tx);
console.log('');
dump('RX (chip -> host)', rx);
