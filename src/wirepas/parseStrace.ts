/**
 * Parse a strace -e trace=read,write -y -x output, extract the byte streams
 * for both directions of a tty, and decode them as Wirepas Dual-MCU frames.
 *
 * Usage:
 *   tsx src/wirepas/parseStrace.ts <capture.strace>
 *   tsx src/wirepas/parseStrace.ts <capture.strace> --tty /dev/ttyS3
 *
 * Strace lines we expect:
 *   read(7</dev/ttyS3>, "\xc0\x84\x01...", 4096) = 17
 *   write(7</dev/ttyS3>, "\xc0\xc0\xc0\x04...", 9) = 9
 *
 * Output: prints separate TX (host->chip) and RX (chip->host) decoded streams,
 * each annotated as it would appear with our regular decodeCapture tool.
 */

import * as fs from 'fs';
import { decodeStream } from './slip';
import { decodePrimitive, parseDsapDataRx, PRIM, PRIM_NAME } from './frame';

const args = process.argv.slice(2);
let path: string | undefined;
let ttyFilter = '/dev/ttyS3';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tty') ttyFilter = args[++i];
  else path = args[i];
}
if (!path) { console.error('usage: parseStrace.ts <file> [--tty /dev/ttyS3]'); process.exit(2); }

const text = fs.readFileSync(path, 'utf8');

/**
 * Decode one C-style escaped string literal (the contents BETWEEN the quotes).
 * Supports \xHH, \\, \", \n, \r, \t, \0, and printable ASCII pass-through.
 */
function decodeEscaped(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(c.charCodeAt(0) & 0xff); continue; }
    const n = s[i + 1];
    if (n === 'x' || n === 'X') {
      const hex = s.slice(i + 2, i + 4);
      out.push(parseInt(hex, 16) & 0xff);
      i += 3;
    } else if (n === 'a') { out.push(0x07); i++; }   // bell
    else if (n === 'b')   { out.push(0x08); i++; }   // backspace
    else if (n === 't')   { out.push(0x09); i++; }   // tab
    else if (n === 'n')   { out.push(0x0a); i++; }   // newline
    else if (n === 'v')   { out.push(0x0b); i++; }   // vertical tab
    else if (n === 'f')   { out.push(0x0c); i++; }   // form feed (the bug — was missing!)
    else if (n === 'r')   { out.push(0x0d); i++; }   // carriage return
    else if (n === 'e')   { out.push(0x1b); i++; }   // escape (GNU)
    else if (n === '0')   { out.push(0x00); i++; }
    else if (n === '\\')  { out.push(0x5c); i++; }
    else if (n === '"')   { out.push(0x22); i++; }
    else if (n === "'")   { out.push(0x27); i++; }
    else { out.push(n.charCodeAt(0) & 0xff); i++; }
  }
  return Buffer.from(out);
}

/**
 * Match strace lines like:
 *   write(7</dev/ttyS3>, "...", 9) = 9
 *   read(7</dev/ttyS3>,  "...", 4096) = 17
 * Returns the captured (op, fd-comment, payload-string-literal, retval).
 */
// strace 4.11 (Ubuntu 16.04) prefixes lines with "<pid>  " (bare digits + 2 spaces).
// strace 5+ uses "[pid <n>] ". Accept both, also no prefix (single-process trace).
const RE = /^(?:\d+\s+|\[pid\s+\d+\]\s+)?(read|write)\((\d+)<([^>]+)>,\s*"((?:[^"\\]|\\.)*)"\s*,\s*\d+\)\s*=\s*(-?\d+)/;

const tx: Buffer[] = [];
const rx: Buffer[] = [];

let lineNo = 0, matched = 0;
for (const raw of text.split('\n')) {
  lineNo++;
  const m = raw.match(RE);
  if (!m) continue;
  const [, op, , fdName, lit, retStr] = m;
  if (fdName !== ttyFilter) continue;
  const ret = Number(retStr);
  if (ret <= 0) continue; // EAGAIN, errors
  const decoded = decodeEscaped(lit);
  // strace truncates per its -s setting; ret tells us how much actually transferred
  const slice = decoded.subarray(0, ret);
  if (op === 'write') tx.push(slice);
  else rx.push(slice);
  matched++;
}

console.log(`# parsed ${lineNo} lines, ${matched} matching ${ttyFilter}`);
console.log(`# TX bytes total: ${tx.reduce((a, b) => a + b.length, 0)}`);
console.log(`# RX bytes total: ${rx.reduce((a, b) => a + b.length, 0)}`);
console.log('');

function printDecoded(label: string, chunks: Buffer[]) {
  console.log(`========== ${label} ==========`);
  const all = Buffer.concat(chunks);
  const { frames, leftover } = decodeStream(all);
  console.log(`# ${frames.length} frame(s), leftover ${leftover.length} byte(s)`);
  for (let n = 0; n < frames.length; n++) {
    const f = frames[n];
    const prim = decodePrimitive(f.payload);
    const crc = f.crcOk ? 'ok ' : 'BAD';
    if (!prim) {
      console.log(`  #${String(n).padStart(3)}  CRC=${crc}  <truncated ${f.payload.toString('hex')}>`);
      continue;
    }
    const name = (PRIM_NAME[prim.primitive] ?? `0x${prim.primitive.toString(16)}`).padEnd(28);
    console.log(
      `  #${String(n).padStart(3)}  CRC=${crc}  ${name}  fid=${prim.frameId.toString(16).padStart(2,'0')}  len=${String(prim.length).padStart(3)}  ${prim.payload.toString('hex')}`,
    );

    if (prim.primitive === PRIM.DSAP_DATA_TX_REQ && prim.payload.length >= 11) {
      const pdu     = prim.payload.readUInt16LE(0);
      const srcEp   = prim.payload[2];
      const dst     = prim.payload.readUInt32LE(3);
      const dstEp   = prim.payload[7];
      const qos     = prim.payload[8];
      const opts    = prim.payload[9];
      const apduLen = prim.payload[10];
      const apdu    = prim.payload.subarray(11, 11 + apduLen);
      console.log(
        `         └── TX  pdu=${pdu.toString(16).padStart(4, '0')} src_ep=${srcEp} ` +
        `dst=0x${dst.toString(16).padStart(8, '0')} dst_ep=${dstEp} qos=${qos} ` +
        `opts=0x${opts.toString(16).padStart(2, '0')} apdu(${apduLen})=${apdu.toString('hex')}`,
      );
    } else if (prim.primitive === PRIM.DSAP_DATA_RX_INDICATION) {
      const ind = parseDsapDataRx(prim.payload);
      if (ind) {
        console.log(
          `         └── RX  src=0x${ind.srcAddress.toString(16).padStart(8, '0')} src_ep=${ind.srcEndpoint} ` +
          `dst=0x${ind.dstAddress.toString(16).padStart(8, '0')} dst_ep=${ind.dstEndpoint} ` +
          `hops=${ind.hopCount} t=${ind.travelTimeMs}ms apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}` +
          (ind.moreQueued ? ' [MORE]' : ''),
        );
      }
    }
  }
}

printDecoded('TX (host -> chip)', tx);
console.log('');
printDecoded('RX (chip -> host)', rx);
