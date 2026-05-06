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
import { buildDsapDataTx, parseDsapDataRx, PRIM, PRIM_NAME, DataRxIndication } from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);

// Captured from gatewaygo's bleunlock for both unit 1213 and unit 1234 — identical bytes,
// so this is the network-layer-authenticated unlock command, not per-lock.
const UNLOCK_APDU = Buffer.from('3400000200a200000000000000000000000000a2', 'hex');
const SRC_EP = 10;
const DST_EP = 9;
const PDU_ID = 0x0001;
const TX_TIMEOUT_MS  = 2_000;
const RX_WAIT_MS     = 6_000;
const POLL_PERIOD_MS = 200;

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

  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: false, pollIntervalMs: 0 });
  await t.open();

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

  console.log(`[unlock] sending DSAP-DATA-TX  src_ep=${SRC_EP} dst_ep=${DST_EP} qos=1 apdu=${UNLOCK_APDU.toString('hex')}`);
  const confirm = await t.send((fid) => buildDsapDataTx(fid, {
    pduId:           PDU_ID,
    sourceEndpoint:  SRC_EP,
    destAddress:     address,
    destEndpoint:    DST_EP,
    qos:             1,
    requestTxIndication: false,
    apdu:            UNLOCK_APDU,
  }), TX_TIMEOUT_MS);
  const txResult = confirm.payload[0];
  console.log(`[unlock] TX confirm result=${txResult} (0=ok, anything else = chip rejected the queue add)`);
  if (txResult !== 0) {
    await t.close();
    return 3;
  }

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
