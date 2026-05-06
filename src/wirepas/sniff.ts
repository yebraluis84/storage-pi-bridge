/**
 * Wirepas mesh sniffer — passively listens to all DSAP_DATA_RX indications
 * and logs them with timestamp, source, destination, endpoints, and APDU.
 *
 * Use to observe real lock activity (e.g. an unlock issued from the Noke app
 * via another gateway will hit our chip as a forwarded DSAP_DATA_RX).
 *
 * Usage:
 *   node dist/wirepas/sniff.js [seconds]      default 120s
 */

import { WirepasTransport } from './transport';
import { parseDsapDataRx, PRIM, PRIM_NAME } from './frame';

const PORT = process.env.WIREPAS_PORT ?? '/dev/ttyS3';
const BAUD = Number(process.env.WIREPAS_BAUD ?? 125000);
const SECONDS = Number(process.argv[2] ?? 120);

async function main(): Promise<number> {
  console.log(`[sniff] opening ${PORT}, listening for ${SECONDS}s`);
  const t = new WirepasTransport({ path: PORT, baudRate: BAUD, debug: false, pollIntervalMs: 0 });
  await t.open();

  let total = 0;
  const bySrc = new Map<number, number>();
  const apduPrefixCount = new Map<string, number>();

  t.on('indication', (p) => {
    if (p.primitive !== PRIM.DSAP_DATA_RX_INDICATION) {
      // Show non-data indications too (state changes, etc.)
      console.log(`${ts()} OTHER  ${PRIM_NAME[p.primitive] ?? '0x'+p.primitive.toString(16)}  payload=${p.payload.toString('hex')}`);
      return;
    }
    const ind = parseDsapDataRx(p.payload);
    if (!ind) return;
    total++;
    bySrc.set(ind.srcAddress, (bySrc.get(ind.srcAddress) ?? 0) + 1);
    const apduPrefix = ind.apdu.slice(0, 4).toString('hex');
    apduPrefixCount.set(apduPrefix, (apduPrefixCount.get(apduPrefix) ?? 0) + 1);
    const src = '0x' + ind.srcAddress.toString(16).padStart(8, '0');
    const dst = '0x' + ind.dstAddress.toString(16).padStart(8, '0');
    console.log(
      `${ts()} RX  src=${src} src_ep=${ind.srcEndpoint}  dst=${dst} dst_ep=${ind.dstEndpoint}  ` +
      `hops=${ind.hopCount}  t=${ind.travelTimeMs}ms  apdu(${ind.apdu.length})=${ind.apdu.toString('hex')}`,
    );
  });

  const start = Date.now();
  while (Date.now() - start < SECONDS * 1000) {
    try { await t.pollIndications(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 100));
  }

  await t.close();

  console.log('');
  console.log(`[sniff] total RX indications: ${total} in ${SECONDS}s (${(total / SECONDS).toFixed(2)}/sec)`);
  console.log('[sniff] by source:');
  const sortedSrc = [...bySrc.entries()].sort((a, b) => b[1] - a[1]);
  for (const [src, count] of sortedSrc.slice(0, 20)) {
    console.log(`  0x${src.toString(16).padStart(8, '0')}  x${count}`);
  }
  console.log('[sniff] by APDU prefix (first 4 bytes):');
  const sortedPrefix = [...apduPrefixCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [prefix, count] of sortedPrefix.slice(0, 20)) {
    console.log(`  ${prefix}  x${count}`);
  }
  return 0;
}

function ts(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);  // HH:MM:SS.mmm
}

main().then(c => process.exit(c), e => { console.error('[sniff] fatal:', e); process.exit(1); });
