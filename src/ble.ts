/**
 * BLE communication with Noke locks.
 *
 * Noke BLE service:
 *   Service UUID:  1bc50001-0200-d29e-e511-446c609db825
 *   TX char:       1bc50002-0200-d29e-e511-446c609db825  (write)
 *   RX char:       1bc50003-0200-d29e-e511-446c609db825  (notify)
 *   Session char:  1bc50004-0200-d29e-e511-446c609db825  (read)
 */

import noble, { Peripheral, Characteristic } from '@abandonware/noble';
import { generateUnlockCommand } from './crypto';

const SERVICE_UUID  = '1bc500010200d29ee511446c609db825';
const TX_UUID       = '1bc500020200d29ee511446c609db825';
const RX_UUID       = '1bc500030200d29ee511446c609db825';
const SESSION_UUID  = '1bc500040200d29ee511446c609db825';

const SCAN_TIMEOUT_MS    = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const UNLOCK_TIMEOUT_MS  = 10_000;

export interface UnlockArgs {
  mac:               string;  // e.g. "F3:25:19:08:73:38"
  offlineKey:        string;  // 32-char hex
  offlineUnlockCmd:  string;  // 40-char hex
}

export interface UnlockResult {
  success:  boolean;
  message:  string;
  duration: number;
  battery?: number;
}

let bleReady = false;

noble.on('stateChange', (state: string) => {
  console.log(`[ble] adapter state: ${state}`);
  bleReady = state === 'poweredOn';
});

export async function waitForBleReady(): Promise<void> {
  if (bleReady) return;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('BLE adapter not ready after 10s')), 10_000);
    const handler = (state: string) => {
      if (state === 'poweredOn') {
        clearTimeout(t);
        noble.removeListener('stateChange', handler);
        bleReady = true;
        resolve();
      }
    };
    noble.on('stateChange', handler);
  });
}

/** Find a peripheral by MAC, with timeout. */
async function findPeripheral(macTarget: string): Promise<Peripheral> {
  const wanted = macTarget.toLowerCase().replace(/:/g, '');

  return new Promise<Peripheral>((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.stopScanning();
      noble.removeAllListeners('discover');
      reject(new Error(`Lock ${macTarget} not found within ${SCAN_TIMEOUT_MS}ms`));
    }, SCAN_TIMEOUT_MS);

    const onDiscover = (p: Peripheral) => {
      const addr = (p.address || '').toLowerCase().replace(/:/g, '');
      if (addr === wanted) {
        clearTimeout(timer);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
        resolve(p);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanning([SERVICE_UUID], false);
  });
}

/** Connect with timeout. */
async function connectWithTimeout(p: Peripheral): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { p.disconnect(); } catch { /* ignore */ }
      reject(new Error('Connect timeout'));
    }, CONNECT_TIMEOUT_MS);

    p.connect((err?: Error | null) => {
      clearTimeout(t);
      if (err) reject(err); else resolve();
    });
  });
}

/** Resolve {tx,rx,session} characteristics. */
async function discoverChars(p: Peripheral): Promise<{ tx: Characteristic; rx: Characteristic; session: Characteristic }> {
  return new Promise((resolve, reject) => {
    p.discoverSomeServicesAndCharacteristics(
      [SERVICE_UUID],
      [TX_UUID, RX_UUID, SESSION_UUID],
      (err, _services, chars) => {
        if (err)            return reject(err);
        if (!chars || chars.length < 3) return reject(new Error('Missing required characteristics'));

        const byUuid = (uuid: string) => chars.find(c => c.uuid === uuid);
        const tx      = byUuid(TX_UUID);
        const rx      = byUuid(RX_UUID);
        const session = byUuid(SESSION_UUID);

        if (!tx || !rx || !session) return reject(new Error('Could not resolve all characteristics'));
        resolve({ tx, rx, session });
      }
    );
  });
}

/** Read session blob from the lock. */
async function readSession(session: Characteristic): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    session.read((err, data) => {
      if (err)  return reject(err);
      if (!data) return reject(new Error('Empty session'));
      resolve(data);
    });
  });
}

/** Subscribe to notifications and return a function that resolves on next message. */
function subscribeRx(rx: Characteristic): () => Promise<Buffer> {
  let pendingResolve:  ((data: Buffer) => void) | null = null;
  let pendingReject:   ((err: Error) => void)  | null = null;

  rx.subscribe();
  rx.on('data', (data: Buffer) => {
    if (pendingResolve) {
      pendingResolve(data);
      pendingResolve = null;
      pendingReject  = null;
    }
  });

  return () => new Promise<Buffer>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject  = reject;
    setTimeout(() => {
      if (pendingReject) {
        pendingReject(new Error('No notification received within timeout'));
        pendingResolve = null;
        pendingReject  = null;
      }
    }, UNLOCK_TIMEOUT_MS);
  });
}

/** Write the unlock command to the TX characteristic. */
async function writeCmd(tx: Characteristic, cmdHex: string): Promise<void> {
  const data = Buffer.from(cmdHex, 'hex');
  return new Promise((resolve, reject) => {
    tx.write(data, false, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * The full unlock dance: scan → connect → handshake → unlock → disconnect.
 */
export async function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const start = Date.now();
  console.log(`[ble] unlocking ${args.mac}...`);

  await waitForBleReady();

  let peripheral: Peripheral | null = null;
  try {
    peripheral = await findPeripheral(args.mac);
    console.log(`[ble]   found peripheral, connecting...`);

    await connectWithTimeout(peripheral);
    console.log(`[ble]   connected, discovering characteristics...`);

    const { tx, rx, session } = await discoverChars(peripheral);

    const sessionData = await readSession(session);
    const sessionHex  = sessionData.toString('hex');
    const battery     = sessionData[2] ?? 0;
    console.log(`[ble]   session=${sessionHex} battery=${battery}%`);

    const waitForResponse = subscribeRx(rx);

    const unlockCmd = generateUnlockCommand(args.offlineKey, args.offlineUnlockCmd, sessionHex);
    console.log(`[ble]   sending unlockCmd=${unlockCmd}`);

    await writeCmd(tx, unlockCmd);
    const response = await waitForResponse();

    const duration = Date.now() - start;
    console.log(`[ble]   response=${response.toString('hex')} (${duration}ms)`);

    return {
      success:  true,
      message:  'Unlocked',
      duration,
      battery,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const message  = err instanceof Error ? err.message : String(err);
    console.error(`[ble]   FAILED: ${message} (${duration}ms)`);
    return { success: false, message, duration };
  } finally {
    if (peripheral && peripheral.state !== 'disconnected') {
      try {
        await new Promise<void>((resolve) => peripheral!.disconnect(() => resolve()));
      } catch { /* ignore */ }
    }
  }
}
