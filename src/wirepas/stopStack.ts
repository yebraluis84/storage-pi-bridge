/**
 * Stop the Wirepas stack on the local Nordic chip.
 *
 * Returns the chip to "stopped" state — it stops routing mesh traffic,
 * stops emitting DSAP_DATA_RX indications, and drops its local route
 * table. Network credentials in flash are NOT erased; a subsequent
 * STACK_START brings it right back online.
 *
 * Run on a gateway:
 *   sudo /usr/local/bin/node /opt/storage-pi-bridge/dist/wirepas/stopStack.js
 * Or (without sudo if pi is in the dialout group):
 *   node /opt/storage-pi-bridge/dist/wirepas/stopStack.js
 */

import { WirepasTransport } from './transport';
import {
  buildStackStop, buildMsapAttrRead, MSAP_ATTR, PRIM_NAME,
} from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);

async function main(): Promise<number> {
  console.log(`[stop-stack] opening ${PORT} @ ${BAUD}`);
  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: true, pollIntervalMs: 0 });
  await t.open();

  t.on('indication', (p) => {
    console.log(`[stop-stack] async ind prim=${PRIM_NAME[p.primitive] ?? p.primitive} fid=${p.frameId} payload=${p.payload.toString('hex')}`);
  });

  const before = await t.send((fid) => buildMsapAttrRead(fid, MSAP_ATTR.STACK_STATUS), 1500);
  const beforeVal = before.payload.subarray(4, 4 + before.payload[3]).toString('hex');
  console.log(`[stop-stack] stack_status before: val=${beforeVal}`);

  console.log('[stop-stack] sending MSAP-STACK-STOP...');
  try {
    const r = await t.send((fid) => buildStackStop(fid), 3000);
    const result = r.payload[0];
    const meaning =
      result === 0 ? 'success' :
      result === 1 ? 'already stopped' :
      result === 4 ? 'access denied' :
      `unknown (${result})`;
    console.log(`[stop-stack] confirm: result=${result} (${meaning})`);
  } catch (e: any) {
    console.error(`[stop-stack] stop failed: ${e.message}`);
    await t.close();
    return 1;
  }

  await new Promise(r => setTimeout(r, 1000));
  const after = await t.send((fid) => buildMsapAttrRead(fid, MSAP_ATTR.STACK_STATUS), 1500);
  const afterVal = after.payload.subarray(4, 4 + after.payload[3]).toString('hex');
  console.log(`[stop-stack] stack_status after: val=${afterVal}`);

  await t.close();
  console.log('[stop-stack] done.');
  return 0;
}

main().then(c => process.exit(c), e => { console.error('[stop-stack] fatal:', e); process.exit(2); });
