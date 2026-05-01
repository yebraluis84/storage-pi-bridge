import { createBluetooth } from 'node-ble';
import { generateUnlockCommand } from './crypto';
const SERVICE_UUID='1bc50001-0200-d29e-e511-446c609db825';
const TX_UUID='1bc50002-0200-d29e-e511-446c609db825';
const RX_UUID='1bc50003-0200-d29e-e511-446c609db825';
const SESSION_UUID='1bc50004-0200-d29e-e511-446c609db825';
const SCAN_TIMEOUT_MS=20_000, CONNECT_TIMEOUT_MS=15_000, GATT_TIMEOUT_MS=10_000, UNLOCK_TIMEOUT_MS=10_000;
export interface UnlockArgs { mac: string; offlineKey: string; offlineUnlockCmd: string; }
export interface UnlockResult { success: boolean; message: string; duration: number; battery?: number; }
console.log('[ble] using BlueZ D-Bus binding (node-ble)');
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(msg)), ms))]);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const start = Date.now();
  console.log(`[ble] unlocking ${args.mac}...`);
  const { bluetooth, destroy } = createBluetooth();
  let device: any = null;
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    console.log('[ble]   scanning...');
    device = await withTimeout(adapter.waitDevice(args.mac.toUpperCase()), SCAN_TIMEOUT_MS, `scan timeout`);
    try { await adapter.stopDiscovery(); } catch {}
    console.log('[ble]   found, connecting...');
    await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connect timeout');
    console.log('[ble]   connected, brief settle...');
    await sleep(2000);
    let gattServer: any = null;
    const gattStart = Date.now();
    while (Date.now() - gattStart < GATT_TIMEOUT_MS) {
      try { gattServer = await withTimeout(device.gatt(), 1500, "retry"); break; }
      catch { await sleep(500); }
    }
    if (!gattServer) throw new Error("gatt() retries exhausted");
    const service: any = await withTimeout(gattServer.getPrimaryService(SERVICE_UUID), GATT_TIMEOUT_MS, 'getPrimaryService timeout');
    const txChar = await service.getCharacteristic(TX_UUID);
    const rxChar = await service.getCharacteristic(RX_UUID);
    const sessionChar = await service.getCharacteristic(SESSION_UUID);
    console.log('[ble]   reading session...');
    const sessionData: Buffer = await withTimeout(sessionChar.readValue(), GATT_TIMEOUT_MS, 'session read timeout');
    const sessionHex = sessionData.toString('hex');
    const battery = sessionData[2] ?? 0;
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ble]   FAILED: ${message} (${duration}ms)`);
    return { success: false, message, duration };
  } finally {
    if (device) { try { await device.disconnect(); } catch {} }
    destroy();
  }
}
