/**
 * Direct lock unlock via Wirepas mesh — no gatewaygo, no Noke cloud.
 *
 * Replays the 20-byte APDU captured from gatewaygo's bleunlock command.
 * The APDU is generic for the unlock operation; the lock authenticates
 * us by virtue of our chip having the same network cipher key, which
 * Wirepas applies at the network layer transparently.
 *
 * Usage:
 *   node dist/wirepas/wirepasUnlock.js 13CD89          # short_mac (3 bytes)
 *   node dist/wirepas/wirepasUnlock.js E8:84:27:13:CD:89   # full BLE MAC
 */

import { WirepasTransport } from './transport';
import {
  buildDsapDataTx, parseDsapDataRx, PRIM, PRIM_NAME, DataRxIndication,
  buildMsapAttrRead, MSAP_ATTR, buildStackStart, buildStackStop,
} from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);

// Captured from gatewaygo's bleunlock for both unit 1213 and unit 1234 — identical bytes,
// so this is the network-layer-authenticated unlock command, not per-lock.
const UNLOCK_APDU = Buffer.from('3400000200a200000000000000000000000000a2', 'hex');

// Pre-unlock mesh broadcasts (captured from gatewaygo startup): the locks
// validate unlock commands against their internal clock to prevent replay,
// so a fresh timezone+time broadcast must hit them before unlock will succeed.
const HELLO_APDU       = Buffer.from('3c', 'hex');                 // ep=9 and ep=13
const TIMEZONE_APDU    = Buffer.from('414038000001', 'hex');        // ep=9 — UTC-4 (Noke's site default)
function buildTimeApdu(): Buffer {
  const t = Math.floor(Date.now() / 1000);
  const apdu = Buffer.alloc(5);
  apdu[0] = 0x40;
  apdu.writeUInt32LE(t, 1);
  return apdu;
}

const SRC_EP = 10;
const DST_EP = 9;     // unlock destination endpoint
const BROADCAST = 0xffffffff;
const TX_TIMEOUT_MS  = 5_000;
const RX_WAIT_MS     = 8_000;
const POLL_PERIOD_MS = 200;
const DEBUG = process.env.WIREPAS_DEBUG !== '0';

function parseTarget(s: string): { shortMac: string; address: number } {
  const clean = s.replace(/[:\s]/g, '').toUpperCase();
  if (clean.length !== 6 && clean.length !== 12) {
    throw new Error(`target must be 3-byte short_mac (6 hex) or full BLE MAC (12 hex), got "${s}"`);
  }
  const shortMac = clean.slice(-6); // last 3 bytes of the MAC
  // 32-bit Wirepas node address: 0x00 high byte + last 3 bytes of MAC.
  // E.g. short_mac "13CD89" -> address 0x0013CD89.
  const address = parseInt(shortMac, 16);
  return { shortMac, address };
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: wirepasUnlock.js <short_mac|full_mac>'); return 2; }

  const { shortMac, address } = parseTarget(arg);
  console.log(`[unlock] target short_mac=${shortMac} -> wirepas dst=0x${address.toString(16).padStart(8, '0')}`);

  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: DEBUG, pollIntervalMs: 0 });
  await t.open();
  void buildMsapAttrRead; void MSAP_ATTR; void buildStackStart; void buildStackStop;

  // ===== Pre-unlock broadcasts (mesh-wide time sync) =====
  // Without these the locks reject unlock commands silently because
  // they can't validate the unlock against a current time window.
  let pdu = 0x0001;
  const broadcastTx = async (label: string, dst_ep: number, apdu: Buffer) => {
    const id = pdu++;
    console.log(`[unlock] broadcast ${label}: pdu=0x${id.toString(16).padStart(4,'0')} dst_ep=${dst_ep} apdu=${apdu.toString('hex')}`);
    try {
      const c = await t.send((fid) => buildDsapDataTx(fid, {
        pduId: id, sourceEndpoint: SRC_EP, destAddress: BROADCAST,
        destEndpoint: dst_ep, qos: 1, requestTxIndication: false, apdu,
      }), TX_TIMEOUT_MS);
      console.log(`[unlock]   confirm result=${c.payload[2]} queue_cap=${c.payload[3]}`);
    } catch (e: any) {
      console.log(`[unlock]   ${label}: ${e.message} (proceeding)`);
    }
    await new Promise(r => setTimeout(r, 100));
  };

  await broadcastTx('hello-ep9 ', 9,  HELLO_APDU);
  await broadcastTx('hello-ep13', 13, HELLO_APDU);
  await broadcastTx('timezone  ', 9,  TIMEZONE_APDU);
  await broadcastTx('time-sync ', 13, buildTimeApdu());

  // Brief settle so locks can update their internal clock before we ask one to unlock
  console.log('[unlock] settling 1.5s for mesh to propagate time sync...');
  await new Promise(r => setTimeout(r, 1500));

  let response: DataRxIndication | null = null;

  t.on('indication', (p) => {
    if (p.primitive !== PRIM.DSAP_DATA_RX_INDICATION) {
      console.log(`[unlock]   async ${PRIM_NAME[p.primitive] ?? '0x' + p.primitive.toString(16)} payload=${p.payload.toString('hex')}`);
      return;
    }
    const ind = parseDsapDataRx(p.payload);
    if (!ind) return;
    const fromAddr = '0x' + ind.srcAddress.toString(16).padStart(8, '0');
    if (ind.srcAddress === address) {
      response = ind;
      console.log(`[unlock]   RESPONSE  from=${fromAddr}  src_ep=${ind.srcEndpoint}  dst_ep=${ind.dstEndpoint}  hops=${ind.hopCount}  t=${ind.travelTimeMs}ms  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`);
    } else {
      console.log(`[unlock]   other RX from=${fromAddr}  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`);
    }
  });

  // Fire-and-forget unlock TX. We don't wait for TX_CONFIRM because it routinely
  // gets buried in indication noise from chatty mesh nodes. Truth is the lock's
  // actual RX response — if that arrives, the unlock worked. If not, no amount
  // of confirm-watching would have helped.
  const pduId = pdu++;
  console.log(`[unlock] firing DSAP-DATA-TX (unlock)  pdu=0x${pduId.toString(16).padStart(4, '0')} src_ep=${SRC_EP} dst_ep=${DST_EP} apdu=${UNLOCK_APDU.toString('hex')}`);
  // Build the frame and write it directly without waiting for the matched confirm
  await t.send((fid) => buildDsapDataTx(fid, {
    pduId, sourceEndpoint: SRC_EP, destAddress: address, destEndpoint: DST_EP,
    qos: 1, requestTxIndication: false, apdu: UNLOCK_APDU,
  }), TX_TIMEOUT_MS).catch((e) => {
    console.log(`[unlock]   TX confirm not received (${e.message}) — proceeding anyway`);
  });

  console.log(`[unlock] waiting up to ${RX_WAIT_MS}ms for lock response...`);
  const start = Date.now();
  while (!response && Date.now() - start < RX_WAIT_MS) {
    try { await t.pollIndications(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, POLL_PERIOD_MS));
  }

  await t.close();

  // TS narrows `response` to `never` because the assignment happens in an event
  // handler closure that TS can't trace. Cast through unknown to defeat narrowing.
  const r = response as unknown as DataRxIndication | null;
  if (r) {
    console.log(`[unlock] SUCCESS — lock responded in ${Date.now() - start}ms`);
    console.log(`[unlock] response APDU first byte 0x${r.apdu[0].toString(16).padStart(2, '0')} (gatewaygo treated 0x50/0x75 as success)`);
    return 0;
  }
  console.log('[unlock] no response from lock within timeout');
  return 1;
}

main().then(code => process.exit(code), e => { console.error('[unlock] fatal:', e); process.exit(2); });
