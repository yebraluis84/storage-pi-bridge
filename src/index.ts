/**
 * Pi Bridge — runs on the Raspberry Pi at the facility.
 *
 * Maintains a WebSocket connection to the Railway backend. When the
 * backend wants to unlock a lock, it sends a message; the Pi does the
 * BLE handshake and sends back the result.
 *
 * Boot:  npm start
 * Dev:   npm run dev
 *
 * Required env vars (.env):
 *   BRIDGE_TOKEN     — shared secret with the backend
 *   BACKEND_WS_URL   — wss://your-railway-app.up.railway.app/bridge
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { unlockLock } from './ble';

dotenv.config();

const TOKEN = process.env.BRIDGE_TOKEN;
const WS_URL = process.env.BACKEND_WS_URL;

if (!TOKEN || !WS_URL) {
  console.error('Missing env vars BRIDGE_TOKEN and/or BACKEND_WS_URL — see README.');
  process.exit(1);
}

interface IncomingMessage {
  type:                'unlock' | 'ping';
  requestId?:          string;
  mac?:                string;
  offlineKey?:         string;
  offlineUnlockCmd?:   string;
}

interface OutgoingMessage {
  type:        'hello' | 'unlock_result' | 'pong';
  requestId?:  string;
  success?:    boolean;
  message?:    string;
  duration?:   number;
  battery?:    number;
  bridgeId?:   string;
}

const RECONNECT_DELAY_MS = 5_000;

function connect(): void {
  console.log(`[ws] connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL!, {
    headers: { 'X-Bridge-Token': TOKEN! },
  });

  ws.on('open', () => {
    console.log('[ws] connected');
    const hello: OutgoingMessage = {
      type:     'hello',
      bridgeId: process.env.BRIDGE_ID ?? 'pi-1',
    };
    ws.send(JSON.stringify(hello));
  });

  ws.on('message', async (buf) => {
    let msg: IncomingMessage;
    try { msg = JSON.parse(buf.toString()) as IncomingMessage; }
    catch { console.warn('[ws] bad JSON'); return; }

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' } satisfies OutgoingMessage));
        break;

      case 'unlock': {
        if (!msg.mac || !msg.offlineKey || !msg.offlineUnlockCmd) {
          ws.send(JSON.stringify({
            type:      'unlock_result',
            requestId: msg.requestId,
            success:   false,
            message:   'Missing mac/offlineKey/offlineUnlockCmd in unlock request',
          } satisfies OutgoingMessage));
          return;
        }

        const result = await unlockLock({
          mac:              msg.mac,
          offlineKey:       msg.offlineKey,
          offlineUnlockCmd: msg.offlineUnlockCmd,
        });

        ws.send(JSON.stringify({
          type:      'unlock_result',
          requestId: msg.requestId,
          success:   result.success,
          message:   result.message,
          duration:  result.duration,
          battery:   result.battery,
        } satisfies OutgoingMessage));
        break;
      }

      default:
        console.warn(`[ws] unknown message type: ${(msg as { type?: string }).type}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[ws] disconnected (${code} ${reason}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
    // close handler will trigger reconnect
  });
}

connect();

console.log('Pi Bridge is running. Press Ctrl+C to exit.');
