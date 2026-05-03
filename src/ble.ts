/**
 * BLE communication with Noke locks.
 *
 * Lessons learned from 6 gateways running in parallel:
 *   - BlueZ leaks state across operations: an old discovery from a previous
 *     unlock will block a new connect, even on a different lock.
 *   - waitDevice() may return a CACHED device that's not in current range,
 *     so connect() then times out. We remove the device from BlueZ before
 *     scanning so we always get a fresh advertisement.
 *   - Multiple unlocks on the same gateway must be serialized — BlueZ can't
 *     handle two parallel BLE operations on one HCI controller.
 *   - createBluetooth() per call leaks D-Bus connections; we keep a singleton.
 */

import { createBluetooth } from 'node-ble';
import { generateUnlockCommand } from './crypto';

const SERVICE_UUID  = '1bc50001-0200-d29e-e511-446c609db825';
const TX_UUID       = '1bc50002-0200-d29e-e511-446c609db825';
const RX_UUID       = '1bc50003-0200-d29e-e511-446c609db825';
const SESSION_UUID  = '1bc50004-0200-d29e-e511-446c609db825';

const SCAN_TIMEOUT_MS   = 12_000;
const CONNECT_TIMEOUT_MS = 8_000;
const GATT_TIMEOUT_MS    = 8_000;
const UNLOCK_TIMEOUT_MS  = 8_000;
const SETTLE_AFTER_CONNECT_MS = 1_500;

export interface UnlockArgs {
  mac:               string;
  offlineKey:        string;
  offlineUnlockCmd:  string;
}
export interface UnlockResult {
  success:  boolean;
  message:  string;
  duration: number;
  battery?: number;
}

console.log('[ble] using BlueZ D-Bus binding (node-ble)');

// Singleton bluetooth/adapter instance — destroyed only on process exit.
let bt: ReturnType<typeof createBluetooth> | null = null;
let adapter: any = null;

async function getAdapter(): Promise<any> {
  if (!bt) bt = createBluetooth();
  if (!adapter) adapter = await bt.bluetooth.defaultAdapter();
  return adapter;
}

process.on('exit', () => { try { bt?.destroy(); } catch {} });

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(msg)), ms))]);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Serialize unlocks on this gateway: BlueZ can't run two BLE ops simultaneously
// on the same HCI adapter without errors.
let unlockChain: Promise<UnlockResult> = Promise.resolve({ success: true, message: '', duration: 0 });

export function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const next = unlockChain.then(() => doUnlock(args), () => doUnlock(args));
  unlockChain = next.catch(() => ({ success: false, message: 'serialized', duration: 0 }));
  return next;
}

async function doUnlock(args: UnlockArgs): Promise<UnlockResult> {
  const start = Date.now();
  const macUpper = args.mac.toUpperCase();
  console.log(`[ble] unlocking ${args.mac}...`);

  let device: any = null;
  try {
    const ad = await getAdapter();

    // 1. Stop any leftover discovery from a previous failed unlock.
    if (await ad.isDiscovering()) {
      try { await withTimeout(ad.stopDiscovery(), 2_000, 'stopDiscovery timeout'); } catch {}
    }

    // 2. Remove cached device entry if present so we get a fresh advertisement.
    //    A cached entry can satisfy waitDevice() even when the lock isn't actually
    //    in range right now, leading to immediate connect timeouts.
    try {
      const known = await ad.devices(); // returns array of MAC strings
      if (Array.isArray(known) && known.includes(macUpper)) {
        await ad.removeDevice(macUpper);
      }
    } catch { /* best-effort */ }

    // 3. Fresh discovery, wait for the device.
    try { await ad.startDiscovery(); } catch (e: any) {
      // "Operation already in progress" is harmless
      if (!String(e?.message ?? '').match(/in progress|already/i)) throw e;
    }
    console.log('[ble]   scanning...');
    device = await withTimeout(ad.waitDevice(macUpper), SCAN_TIMEOUT_MS, 'scan timeout');

    // 4. Stop discovery before connecting (BlueZ recommends this).
    try { await withTimeout(ad.stopDiscovery(), 2_000, 'stopDiscovery timeout'); } catch {}

    console.log('[ble]   found, connecting...');
    await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connect timeout');
    console.log('[ble]   connected, settling...');
    await sleep(SETTLE_AFTER_CONNECT_MS);

    // 5. Resolve GATT — sometimes needs a couple of retries right after connect.
    let gattServer: any = null;
    const gattStart = Date.now();
    while (Date.now() - gattStart < GATT_TIMEOUT_MS) {
      try { gattServer = await withTimeout(device.gatt(), 1_500, 'gatt retry'); break; }
      catch { await sleep(400); }
    }
    if (!gattServer) throw new Error('gatt() retries exhausted');

    const service: any = await withTimeout(gattServer.getPrimaryService(SERVICE_UUID), GATT_TIMEOUT_MS, 'getPrimaryService timeout');
    const txChar      = await service.getCharacteristic(TX_UUID);
    const rxChar      = await service.getCharacteristic(RX_UUID);
    const sessionChar = await service.getCharacteristic(SESSION_UUID);

    console.log('[ble]   reading session...');
    const sessionData: Buffer = await withTimeout(sessionChar.readValue(), GATT_TIMEOUT_MS, 'session read timeout');
    const sessionHex = sessionData.toString('hex');
    const battery    = sessionData[2] ?? 0;
    console.log(`[ble]   session=${sessionHex} battery=${battery}%`);

    const responsePromise = new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('No notification within timeout')), UNLOCK_TIMEOUT_MS);
      rxChar.once('valuechanged', (data: Buffer) => { clearTimeout(t); resolve(data); });
    });
    await rxChar.startNotifications();

    const unlockCmd = generateUnlockCommand(args.offlineKey, args.offlineUnlockCmd, sessionHex);
    console.log(`[ble]   sending unlockCmd=${unlockCmd}`);
    await txChar.writeValue(Buffer.from(unlockCmd, 'hex'), { type: 'request' });

    const response = await responsePromise;
    const duration = Date.now() - start;
    console.log(`[ble]   response=${response.toString('hex')} (${duration}ms)`);
    try { await rxChar.stopNotifications(); } catch {}

    return { success: true, message: 'Unlocked', duration, battery };
  } catch (err) {
    const duration = Date.now() - start;
    const message  = err instanceof Error ? err.message : String(err);
    console.error(`[ble]   FAILED: ${message} (${duration}ms)`);
    return { success: false, message, duration };
  } finally {
    // Disconnect cleanly so the lock and adapter aren't left in a half-state
    if (device) {
      try { await withTimeout(device.disconnect(), 2_000, 'disconnect timeout'); } catch {}
    }
    // Make sure discovery is off after every attempt
    try {
      const ad = await getAdapter();
      if (await ad.isDiscovering()) await ad.stopDiscovery();
    } catch {}
  }
}
