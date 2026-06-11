/**
 * Start the Wirepas stack on the local Nordic chip.
 *
 * The chip persists its network credentials (network address, channel,
 * cipher keys) across reboots, so a bare STACK_START is enough to bring
 * it online — no re-keying needed. Once started, the chip joins the mesh
 * as a routing node and begins receiving DSAP_DATA_RX indications for
 * traffic addressed to or forwarded through it.
 *
 * Pair with stopStack.ts for a clean shutdown.
 *
 * Run on a gateway:
 *   sudo /usr/local/bin/node /opt/storage-pi-bridge/dist/wirepas/startStack.js
 * Or (without sudo if pi is in the dialout group):
 *   node /opt/storage-pi-bridge/dist/wirepas/startStack.js
 */

import { WirepasTransport } from './transport';
import {
  buildStackStart, buildMsapAttrRead, MSAP_ATTR, PRIM, PRIM_NAME,
} from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);

async function main(): Promise<number> {
  console.log(`[start-stack] opening ${PORT} @ ${BAUD}`);
  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: true, pollIntervalMs: 0 });
  await t.open();

  t.on('indication', (p) => {
    console.log(`[start-stack] async ind prim=${PRIM_NAME[p.primitive] ?? p.primitive} fid=${p.frameId} payload=${p.payload.toString('hex')}`);
  });

  // 1. Read current stack_status so we can compare before/after.
  const before = await t.send((fid) => buildMsapAttrRead(fid, MSAP_ATTR.STACK_STATUS), 1500);
  const beforeVal = before.payload.subarray(4, 4 + before.payload[3]).toString('hex');
  console.log(`[start-stack] stack_status before: val=${beforeVal} (0x00 = running, bit 0 set = stopped)`);

  // 2. Send MSAP-STACK-START. autostart=true means the chip will re-start
  //    automatically on power cycle going forward.
  console.log('[start-stack] sending MSAP-STACK-START (autostart=true)...');
  try {
    const r = await t.send((fid) => buildStackStart(fid, true), 3000);
    const result = r.payload[0];
    // Result codes per DualMcuAPI.md:
    //   0=success, 1=already started, 2=invalid role/network/etc, 4=access denied,
    //   5=stack remains stopped, 6=invalid app config.
    const meaning =
      result === 0 ? 'success' :
      result === 1 ? 'already started' :
      result === 2 ? 'configuration error (missing network/role)' :
      result === 4 ? 'access denied' :
      result === 5 ? 'stack remains stopped' :
      result === 6 ? 'invalid app config' :
      `unknown (${result})`;
    console.log(`[start-stack] confirm: result=${result} (${meaning})`);
  } catch (e: any) {
    console.error(`[start-stack] start failed: ${e.message}`);
    await t.close();
    return 1;
  }

  // 3. Give the stack a moment to settle, then re-read stack_status.
  await new Promise(r => setTimeout(r, 1500));
  const after = await t.send((fid) => buildMsapAttrRead(fid, MSAP_ATTR.STACK_STATUS), 1500);
  const afterVal = after.payload.subarray(4, 4 + after.payload[3]).toString('hex');
  console.log(`[start-stack] stack_status after: val=${afterVal}`);

  // 4. Drain any async indications (early state changes, mesh joins, etc.).
  console.log('[start-stack] draining 3s of async indications...');
  const drainStart = Date.now();
  while (Date.now() - drainStart < 3_000) {
    try { await t.pollIndications(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 200));
  }

  await t.close();
  // Note: closing the serial doesn't stop the stack. The chip keeps running
  // on its own; we just released the host UART. sniff.js can now reattach
  // and see DSAP_DATA_RX traffic.
  console.log('[start-stack] done. Chip is now meshing; sniff.js to observe.');
  return 0;
}

main().then(c => process.exit(c), e => { console.error('[start-stack] fatal:', e); process.exit(2); });
