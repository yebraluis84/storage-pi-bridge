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
import { exec } from 'child_process';
import * as net from 'net';
import { unlockLock } from './ble';

dotenv.config();

const TOKEN = process.env.BRIDGE_TOKEN;
const WS_URL = process.env.BACKEND_WS_URL;

if (!TOKEN || !WS_URL) {
  console.error('Missing env vars BRIDGE_TOKEN and/or BACKEND_WS_URL — see README.');
  process.exit(1);
}

// Don't let an unhandled async error kill the bridge. Log it loudly so we
// can fix the underlying bug, but keep the WebSocket and BLE loops alive.
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaughtException:', err);
});

interface IncomingMessage {
  type:                'unlock' | 'ping' | 'restart_gatewaygo' | 'probe_gatewaygo';
  requestId?:          string;
  mac?:                string;
  offlineKey?:         string;
  offlineUnlockCmd?:   string;
}

interface OutgoingMessage {
  type:        'hello' | 'unlock_result' | 'pong' | 'restart_gatewaygo_result' | 'probe_gatewaygo_result';
  requestId?:  string;
  success?:    boolean;
  message?:    string;
  duration?:   number;
  battery?:    number;
  bridgeId?:   string;
}

const RECONNECT_DELAY_MS    = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;  // send a WS ping every 30s
// If no pong arrives between heartbeats, the connection is stale (likely
// half-open after a Railway redeploy or a NAT timeout). Terminate the
// socket so the close handler triggers a reconnect.

function connect(): void {
  console.log(`[ws] connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL!, {
    headers: { 'X-Bridge-Token': TOKEN! },
  });

  // Heartbeat watchdog. `alive` flips false on each ping; the next pong
  // flips it back. If a full interval passes with no pong, the socket
  // is dead and we force a reconnect.
  let alive = true;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };
  const startHeartbeat = () => {
    alive = true;
    heartbeatTimer = setInterval(() => {
      if (!alive) {
        console.warn('[ws] no pong in last interval — terminating stale socket');
        try { ws.terminate(); } catch { /* ignore */ }
        return;  // close handler will reconnect
      }
      alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS);
  };

  ws.on('open', () => {
    console.log('[ws] connected');
    startHeartbeat();
    const hello: OutgoingMessage = {
      type:     'hello',
      bridgeId: process.env.BRIDGE_ID ?? 'pi-1',
    };
    ws.send(JSON.stringify(hello));
  });

  // ws library's `pong` event fires when the server replies to our ping.
  ws.on('pong', () => { alive = true; });

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

      case 'restart_gatewaygo': {
        console.log('[ws] restart_gatewaygo requested');
        const result = await restartGatewaygo();
        ws.send(JSON.stringify({
          type:      'restart_gatewaygo_result',
          requestId: msg.requestId,
          success:   result.success,
          message:   result.message,
        } satisfies OutgoingMessage));
        break;
      }

      case 'probe_gatewaygo': {
        console.log('[ws] probe_gatewaygo requested');
        const result = await probeGatewaygo();
        ws.send(JSON.stringify({
          type:      'probe_gatewaygo_result',
          requestId: msg.requestId,
          success:   result.success,
          message:   result.message,
        } satisfies OutgoingMessage));
        break;
      }

      default:
        console.warn(`[ws] unknown message type: ${(msg as { type?: string }).type}`);
    }
  });

  ws.on('close', (code, reason) => {
    stopHeartbeat();
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

// ─── Diagnostic / control helpers ───────────────────────────────────

/** Restart the gatewaygo systemd service. Pi-bridge runs as root, so this is allowed. */
function restartGatewaygo(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    exec('systemctl restart gatewaygo', { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ success: false, message: `restart failed: ${stderr.trim() || err.message}` });
        return;
      }
      resolve({ success: true, message: 'gatewaygo restarted' });
    });
  });
}

/** Probe gatewaygo's local CLI by sending `version\n` on 127.0.0.1:5299.
 *  Useful for telling whether gatewaygo is actually responsive (vs. just accepting connections). */
function probeGatewaygo(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = '';
    let done = false;
    const finish = (success: boolean, message: string) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ success, message });
    };
    const timer = setTimeout(() => finish(false, 'probe timeout (3s) — gatewaygo accepted but did not respond'), 3_000);

    sock.on('connect', () => sock.write('version\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Any response means gatewaygo's CLI is alive. Trim and return first line(s).
      if (buf.length > 0) {
        clearTimeout(timer);
        const head = buf.trim().split('\n').slice(0, 3).join(' | ').slice(0, 240);
        finish(true, head || '(empty response)');
      }
    });
    sock.on('end', () => {
      clearTimeout(timer);
      if (buf.length === 0) finish(false, 'gatewaygo closed without responding');
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(false, `connect error: ${err.message}`);
    });
    sock.connect(5299, '127.0.0.1');
  });
}
