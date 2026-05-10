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
  type:                'unlock' | 'ping' | 'restart_gatewaygo' | 'probe_gatewaygo' | 'pulse_relay';
  requestId?:          string;
  mac?:                string;
  offlineKey?:         string;
  offlineUnlockCmd?:   string;
  // pulse_relay
  host?:               string;
  channel?:            number;
  pulseSeconds?:       number;
  user?:               string | null;
  password?:           string | null;
}

interface OutgoingMessage {
  type:        'hello' | 'unlock_result' | 'pong' | 'restart_gatewaygo_result' | 'probe_gatewaygo_result' | 'pulse_relay_result';
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

      case 'pulse_relay': {
        if (!msg.host || typeof msg.pulseSeconds !== 'number') {
          ws.send(JSON.stringify({
            type:      'pulse_relay_result',
            requestId: msg.requestId,
            success:   false,
            message:   'Missing host/pulseSeconds in pulse_relay request',
          } satisfies OutgoingMessage));
          return;
        }
        console.log(`[ws] pulse_relay -> ${msg.host} ch${msg.channel ?? 0} for ${msg.pulseSeconds}s`);
        const result = await pulseShellyRelay({
          host:         msg.host,
          channel:      msg.channel ?? 0,
          pulseSeconds: msg.pulseSeconds,
          user:         msg.user ?? null,
          password:     msg.password ?? null,
        });
        ws.send(JSON.stringify({
          type:      'pulse_relay_result',
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

/**
 * Pulse a Shelly Plus 1 / 1PM relay over the local LAN. Uses Shelly's
 * Gen2 RPC HTTP API:
 *   GET http://<host>/rpc/Switch.Set?id=<ch>&on=true&toggle_after=<sec>
 * which turns the relay on then back off after `toggle_after` seconds —
 * exactly the same as a momentary press of a wall button.
 *
 * Optional basic-auth: Shelly Gen2 only requires a password (username is
 * always "admin"); both are passed through if configured.
 */
async function pulseShellyRelay(opts: {
  host:         string;
  channel:      number;
  pulseSeconds: number;
  user:         string | null;
  password:     string | null;
}): Promise<{ success: boolean; message: string }> {
  // Cap the pulse to a sane range. Anything below 0.1s is unreliable;
  // anything above 5s and you risk the door command repeating.
  const pulse = Math.max(0.1, Math.min(opts.pulseSeconds, 5));
  const url = `http://${opts.host}/rpc/Switch.Set?id=${opts.channel}&on=true&toggle_after=${pulse}`;

  const headers: Record<string, string> = {};
  if (opts.password) {
    const user = opts.user || 'admin';
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${opts.password}`).toString('base64');
  }

  // Node 18+ has fetch built-in. Pi-bridge runs node 20.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { success: false, message: `Shelly HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    return { success: true, message: `pulsed ${opts.host} ch${opts.channel} for ${pulse}s` };
  } catch (err) {
    clearTimeout(timer);
    return { success: false, message: `Shelly fetch failed: ${(err as Error).message}` };
  }
}
