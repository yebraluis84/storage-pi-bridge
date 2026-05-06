/**
 * Self-test for the Wirepas SLIP+CRC codec. No hardware needed.
 *
 * Run: tsx src/wirepas/selftest.ts
 *
 * Verifies:
 *   1. CRC-16-CCITT (XMODEM) on the standard "123456789" vector → 0x29B1.
 *   2. SLIP encode/decode round-trips arbitrary payloads, including 0xC0/0xDB.
 *   3. Wirepas frame round-trips: build a DSAP-DATA_TX, encode, decode, parse.
 */

import { crc16Ccitt, encodeFrame, decodeStream } from './slip';
import { buildDsapDataTx, decodePrimitive, parseDsapDataRx, PRIM } from './frame';

let failures = 0;
function assertEq<T>(name: string, got: T, want: T, fmt: (v: T) => string = String) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ok ' : 'FAIL'}  ${name}: got=${fmt(got)} want=${fmt(want)}`);
  if (!ok) failures++;
}

// 1. CRC test vector
const v = Buffer.from('123456789');
assertEq('CRC-16/CCITT-FALSE("123456789")',
  crc16Ccitt(v).toString(16).padStart(4, '0'), '29b1');

// 2. SLIP round-trip with bytes that need escaping. Each seed must be
//    >=3 bytes because that's the minimum Wirepas header (prim+fid+len).
for (const seed of [
  Buffer.from([0x01, 0x02, 0xc0, 0xdb, 0xdc, 0xdd, 0xff, 0x00]),
  Buffer.from([0x04, 0x00, 0x00]), // MSAP-INDICATION_POLL.request, no payload
  Buffer.from('hello world'),
  Buffer.alloc(150).fill(0xc0),
]) {
  const wire = encodeFrame(seed);
  const { frames, leftover } = decodeStream(wire);
  assertEq(`round-trip n=${seed.length} crcOk`,    frames[0]?.crcOk ?? false, true);
  assertEq(`round-trip n=${seed.length} payload`,  frames[0]?.payload.toString('hex') ?? '', seed.toString('hex'));
  assertEq(`round-trip n=${seed.length} leftover`, leftover.length, 0);
}

// 3. End-to-end: build a DSAP-DATA_TX, encode for wire, decode, parse it back
const apdu = Buffer.from('aa55deadbeefcafe', 'hex');
const fid = 0x42;
const built = buildDsapDataTx(fid, {
  pduId: 0x1234,
  sourceEndpoint: 1,
  destAddress: 0x12345678,
  destEndpoint: 2,
  qos: 1,
  requestTxIndication: true,
  hopLimit: 5,
  apdu,
});
const onWire = encodeFrame(built);
const { frames } = decodeStream(onWire);
const prim = decodePrimitive(frames[0].payload);
assertEq('tx primitive id', prim?.primitive, PRIM.DSAP_DATA_TX_REQ);
assertEq('tx frame id',     prim?.frameId,    fid);
assertEq('tx pduId',        prim ? prim.payload.readUInt16LE(0) : -1, 0x1234);
assertEq('tx destAddress',  prim ? prim.payload.readUInt32LE(3) : -1, 0x12345678);
assertEq('tx apdu',         prim ? prim.payload.subarray(11).toString('hex') : '', apdu.toString('hex'));

// 4. Parse a synthetic DSAP-DATA_RX.indication (verifies field offsets)
const rxPayload = Buffer.alloc(17 + 4);
rxPayload[0]  = 0;                                 // moreQueued = false
rxPayload.writeUInt32LE(0x000000aa, 1);            // src
rxPayload[5]  = 1;                                 // src_ep
rxPayload.writeUInt32LE(0x12345678, 6);            // dst
rxPayload[10] = 2;                                 // dst_ep
rxPayload[11] = (3 << 2) | 1;                      // hops=3 qos=1
rxPayload.writeUInt32LE(128, 12);                  // 1 second
rxPayload[16] = 4;                                 // apduLen
Buffer.from([0xde, 0xad, 0xbe, 0xef]).copy(rxPayload, 17);
const rx = parseDsapDataRx(rxPayload)!;
assertEq('rx srcAddress',  rx.srcAddress, 0x000000aa);
assertEq('rx hopCount',    rx.hopCount,   3);
assertEq('rx travelTime',  rx.travelTimeMs, 1000);
assertEq('rx apdu',        rx.apdu.toString('hex'), 'deadbeef');

console.log('');
if (failures === 0) console.log('all checks passed.');
else { console.error(`${failures} check(s) failed.`); process.exit(1); }
