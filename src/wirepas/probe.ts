/**
 * First-contact probe for the Nordic Wirepas chip on a converted gateway.
 *
 * Goal: prove we can talk to the chip with our own client, without running
 * gatewaygo. Reads safe attributes (stack status, route count, MTU, version)
 * and dumps anything else that arrives during a brief listen window.
 *
 * Run on a gateway:
 *   sudo systemctl stop gatewaygo                    # if it's running
 *   sudo /usr/local/bin/node dist/wirepas/probe.js   # after build
 * Or:
 *   sudo npx tsx src/wirepas/probe.ts
 *
 * If you see "stack_status confirm result=00 val=00" or similar, we're in.
 */

import { WirepasTransport } from './transport';
import {
  buildMsapAttrRead, buildCsapAttrRead, MSAP_ATTR, CSAP_ATTR, decodePrimitive, PRIM_NAME,
} from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);
const LISTEN_MS = Number(process.env.WIREPAS_LISTEN_MS ?? 5000);

async function main() {
  console.log(`[probe] opening ${PORT} @ ${BAUD}`);
  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: true, pollIntervalMs: 0 });
  await t.open();

  t.on('indication', (p) => {
    console.log(`[probe] async indication prim=${PRIM_NAME[p.primitive] ?? p.primitive} fid=${p.frameId} payload=${p.payload.toString('hex')}`);
  });
  t.on('crcError', (b) => console.warn(`[probe] CRC error: ${b.toString('hex')}`));
  t.on('error', (e) => console.error(`[probe] transport error: ${e.message}`));

  // 1. MSAP attributes — safe to read while stack is running
  for (const [name, id] of [
    ['stack_status',         MSAP_ATTR.STACK_STATUS],
    ['pdu_buffer_usage',     MSAP_ATTR.PDU_BUFFER_USAGE],
    ['pdu_buffer_capacity',  MSAP_ATTR.PDU_BUFFER_CAPACITY],
    ['route_count',          MSAP_ATTR.ROUTE_COUNT],
  ] as const) {
    try {
      const r = await t.send((fid) => buildMsapAttrRead(fid, id), 1500);
      const result = r.payload[0];
      const attrId = r.payload.readUInt16LE(1);
      const len    = r.payload[3];
      const val    = r.payload.subarray(4, 4 + len).toString('hex');
      console.log(`[probe] MSAP ${name.padEnd(20)} result=${result} id=${attrId} val=${val}`);
    } catch (e: any) {
      console.warn(`[probe] MSAP ${name} FAILED: ${e.message}`);
    }
  }

  // 2. A few CSAP attributes — these usually require the stack to be stopped,
  //    so the chip will respond with a non-zero result code. That's still a
  //    valid signal: the chip is alive and responsive.
  for (const [name, id] of [
    ['node_address',     CSAP_ATTR.NODE_ADDRESS],
    ['network_address',  CSAP_ATTR.NETWORK_ADDRESS],
    ['network_channel',  CSAP_ATTR.NETWORK_CHANNEL],
    ['mesh_api_version', CSAP_ATTR.MESH_API_VERSION],
    ['firmware_major',   CSAP_ATTR.FIRMWARE_MAJOR],
    ['firmware_minor',   CSAP_ATTR.FIRMWARE_MINOR],
  ] as const) {
    try {
      const r = await t.send((fid) => buildCsapAttrRead(fid, id), 1500);
      const result = r.payload[0];
      const attrId = r.payload.readUInt16LE(1);
      const len    = r.payload[3];
      const val    = r.payload.subarray(4, 4 + len).toString('hex');
      console.log(`[probe] CSAP ${name.padEnd(20)} result=${result} id=${attrId} val=${val}`);
    } catch (e: any) {
      console.warn(`[probe] CSAP ${name} FAILED: ${e.message}`);
    }
  }

  // 3. Drain any pending indications.
  console.log(`[probe] polling indications, listening ${LISTEN_MS}ms for async traffic...`);
  try { await t.pollIndications(); } catch (e: any) { console.warn(`[probe] poll: ${e.message}`); }
  await new Promise((r) => setTimeout(r, LISTEN_MS));

  await t.close();
  console.log('[probe] done.');
}

main().catch((e) => { console.error('[probe] fatal:', e); process.exit(1); });
