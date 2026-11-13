/**
 * Bench check for the LoRa gateway, no cloud needed.
 *
 *   npm run lora:selftest                      # auto-detect port, latch 1
 *   npm run lora:selftest -- /dev/ttyACM0 2    # explicit port and latch id
 *   LORA_DEBUG=1 npm run lora:selftest         # print every serial line
 *
 * Opens the port, waits for HELLO, pings the latch, unlocks it, then listens
 * for heartbeats for 20 s and exits.
 */

import { LoraGateway } from './loraGateway';

const path    = process.argv[2] || process.env.LORA_SERIAL_PATH || undefined;
const latchId = Number(process.argv[3] || 1);

const gw = new LoraGateway({ path, debug: process.env.LORA_DEBUG === '1' });
gw.on('open',   (p)  => console.log(`[selftest] port open ${p}`));
gw.on('close',  (r)  => console.log(`[selftest] closed: ${r}`));
gw.on('status', (s)  => console.log(`[selftest] status id=${s.latchId} ${s.type} bolt=${s.bolt} fired=${s.fired} mismatch=${s.mismatch} rssi=${s.rssi} snr=${s.snr}`));
gw.on('error',  (e)  => console.log(`[selftest] error: ${e.message}`));

gw.once('ready', async (fw) => {
  console.log(`[selftest] firmware: ${fw}`);
  try {
    const pong = await gw.ping(latchId);
    console.log(`[selftest] ping ok: bolt=${pong.bolt} rssi=${pong.rssi}`);
    const t0 = Date.now();
    const st = await gw.unlock(latchId);
    console.log(`[selftest] unlock ${st.bolt === 'open' ? 'OK' : 'FAILED (sensor says locked)'} in ${Date.now() - t0} ms`);
  } catch (e) {
    console.log(`[selftest] FAILED: ${(e as Error).message}`);
  }
  console.log('[selftest] listening for heartbeats for 20 s...');
  setTimeout(() => { gw.stop(); process.exit(0); }, 20_000);
});

gw.start();
setTimeout(() => {
  if (!gw.ready) { console.log('[selftest] no gateway firmware answered within 15 s'); gw.stop(); process.exit(1); }
}, 15_000);
