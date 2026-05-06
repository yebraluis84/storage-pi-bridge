/**
 * Decode a SLIP capture of UART traffic between gatewaygo and the Nordic chip.
 *
 * Usage:
 *   tsx src/wirepas/decodeCapture.ts <file>           # auto: hex or raw
 *   tsx src/wirepas/decodeCapture.ts --hex <file>     # force hex (whitespace-tolerant)
 *   cat dump.hex | tsx src/wirepas/decodeCapture.ts -
 *
 * The capture file is treated as a single direction. If you have a bidirectional
 * MITM capture, split it into host->stack and stack->host streams before feeding.
 *
 * Output format (one line per frame):
 *   #N  CRC=ok  prim=DSAP_DATA_TX_REQ(0x01) fid=07 len=27  <hexpayload>
 *      └── decoded fields when known
 */

import * as fs from 'fs';
import { decodeStream } from './slip';
import { decodePrimitive, parseDsapDataRx, PRIM } from './frame';

function readInput(): Buffer {
  const args = process.argv.slice(2);
  let forceHex = false;
  let path: string | undefined;
  for (const a of args) {
    if (a === '--hex') forceHex = true;
    else path = a;
  }
  if (!path) { console.error('usage: decodeCapture.ts [--hex] <file|->'); process.exit(2); }

  const raw = path === '-' ? fs.readFileSync(0) : fs.readFileSync(path);

  if (forceHex || looksLikeHex(raw)) {
    const cleaned = raw.toString('utf8')
      .replace(/0x/gi, '')
      .replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length % 2 !== 0) {
      console.error(`hex input has odd length (${cleaned.length}) — ignoring trailing nibble`);
    }
    return Buffer.from(cleaned.slice(0, cleaned.length & ~1), 'hex');
  }
  return raw;
}

function looksLikeHex(buf: Buffer): boolean {
  // Heuristic: first 256 bytes are mostly printable hex / whitespace
  const head = buf.subarray(0, Math.min(256, buf.length)).toString('utf8');
  let hex = 0, total = 0;
  for (const ch of head) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    total++;
    if (/[0-9a-fA-Fx]/.test(ch)) hex++;
  }
  return total > 0 && hex / total > 0.95;
}

function hex(b: Buffer): string {
  return Buffer.from(b).toString('hex');
}
function pad(s: string, n: number): string { return (s + ' '.repeat(n)).slice(0, n); }

const bytes = readInput();
console.log(`# input: ${bytes.length} bytes`);
const { frames, leftover } = decodeStream(bytes);
console.log(`# frames: ${frames.length}, leftover: ${leftover.length} bytes`);
console.log('');

for (let n = 0; n < frames.length; n++) {
  const f = frames[n];
  const prim = decodePrimitive(f.payload);
  const crc  = f.crcOk ? 'ok ' : 'BAD';
  if (!prim) {
    console.log(`#${pad(String(n), 3)}  CRC=${crc}  <truncated: ${hex(f.payload)}>`);
    continue;
  }
  const head =
    `#${pad(String(n), 3)}  CRC=${crc}  ` +
    `prim=${pad(prim.primitiveName, 28)}(0x${prim.primitive.toString(16).padStart(2, '0')}) ` +
    `fid=${prim.frameId.toString(16).padStart(2, '0')} ` +
    `len=${pad(String(prim.length), 3)} ` +
    hex(prim.payload);
  console.log(head);

  switch (prim.primitive) {
    case PRIM.DSAP_DATA_TX_REQ: {
      if (prim.payload.length < 11) break;
      const pdu  = prim.payload.readUInt16LE(0);
      const srcEp = prim.payload[2];
      const dst  = prim.payload.readUInt32LE(3);
      const dstEp = prim.payload[7];
      const qos  = prim.payload[8];
      const opts = prim.payload[9];
      const apduLen = prim.payload[10];
      const apdu = prim.payload.subarray(11, 11 + apduLen);
      console.log(
        `      └── TX  pdu=${pdu.toString(16).padStart(4, '0')} src_ep=${srcEp} ` +
        `dst=0x${dst.toString(16).padStart(8, '0')} dst_ep=${dstEp} qos=${qos} ` +
        `opts=0x${opts.toString(16).padStart(2, '0')} apdu(${apduLen})=${hex(apdu)}`,
      );
      break;
    }
    case PRIM.DSAP_DATA_RX_INDICATION: {
      const ind = parseDsapDataRx(prim.payload);
      if (!ind) break;
      console.log(
        `      └── RX  src=0x${ind.srcAddress.toString(16).padStart(8, '0')} src_ep=${ind.srcEndpoint} ` +
        `dst=0x${ind.dstAddress.toString(16).padStart(8, '0')} dst_ep=${ind.dstEndpoint} ` +
        `hops=${ind.hopCount} t=${ind.travelTimeMs}ms apdu(${ind.apdu.length})=${hex(ind.apdu)}` +
        (ind.moreQueued ? ' [MORE]' : ''),
      );
      break;
    }
    case PRIM.MSAP_ATTR_READ_REQ:
    case PRIM.CSAP_ATTR_READ_REQ: {
      if (prim.payload.length < 2) break;
      const attr = prim.payload.readUInt16LE(0);
      console.log(`      └── attr_read id=${attr}`);
      break;
    }
    case PRIM.MSAP_ATTR_READ_CONFIRM:
    case PRIM.CSAP_ATTR_READ_CONFIRM: {
      if (prim.payload.length < 4) break;
      const result = prim.payload[0];
      const attr   = prim.payload.readUInt16LE(1);
      const len    = prim.payload[3];
      const val    = prim.payload.subarray(4, 4 + len);
      console.log(`      └── attr_confirm result=${result} id=${attr} val=${hex(val)}`);
      break;
    }
  }
}

if (leftover.length > 0) {
  console.log('');
  console.log(`# leftover (unparsed tail, ${leftover.length} bytes): ${hex(leftover)}`);
}
