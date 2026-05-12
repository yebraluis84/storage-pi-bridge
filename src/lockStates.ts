/**
 * Lock-state poller.
 *
 * Reads gatewaygo's local SQLite DB (master_lock_list) on a regular interval
 * and publishes a snapshot to the backend over the existing WebSocket. The
 * backend merges snapshots from all 12 bridges (freshest-updatedAt-wins per
 * MAC) so the manager dashboard can show real locked/unlocked counts.
 *
 * Why a snapshot (not deltas):
 *   - 393 locks × ~80B per row ≈ 30 KB per tick; bandwidth is not the limit.
 *   - Backend restart auto-recovers because every tick is self-contained.
 *
 * SQLite is opened read-only on each tick. gatewaygo holds the DB with
 * journal_mode=delete; concurrent reads work but may briefly block on
 * gatewaygo's writes. That's fine.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import type { WebSocket } from 'ws';

const DEFAULT_DB_PATH    = '/usr/local/bin/gw.sqlite';
const DEFAULT_INTERVAL   = 30_000;
const WS_OPEN            = 1;

interface LockRow {
  mac:             string;   // full MAC, colon-separated, uppercase (e.g. "D4:16:E9:55:6D:8C")
  short:           string;   // 6-hex no separators, uppercase ("556D8C")
  state:           'LOCKED' | 'UNLOCKED';
  updatedAt:       string;   // raw lock_state_updated from gatewaygo
  hops:            number;
  nextHopMac:      string;   // mesh address of the next routing hop toward this gateway
  nextHopRssi:     number;   // dBm of that hop; closer to 0 = stronger
  linkQuality:     number;   // gatewaygo's composite quality score; -1 if unknown
  wiredVoltage:    number;   // current input voltage in V; 0 or -1000 = no data
  wiredVoltageAvg: number;   // averaged across recent readings
  wiredVoltageMin: number;   // lowest observed
  lockLastSeen:    string;   // last mesh contact (any traffic), distinct from updatedAt
}

interface LockStatesMessage {
  type:     'lock_states';
  bridgeId: string;
  pollAt:   string;
  total:    number;
  locks:    LockRow[];
}

export function startLockStatePoller(opts: {
  ws:        WebSocket;
  bridgeId:  string;
  dbPath?:   string;
  intervalMs?: number;
}): () => void {
  const dbPath     = opts.dbPath ?? process.env.GW_SQLITE_PATH ?? DEFAULT_DB_PATH;
  const envInterval = Number(process.env.LOCK_STATES_POLL_MS);
  const intervalMs  = opts.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL);

  const tick = () => {
    if (opts.ws.readyState !== WS_OPEN) return;
    let db: Database.Database | null = null;
    try {
      if (!fs.existsSync(dbPath)) {
        console.warn(`[lock-states] db not found at ${dbPath}`);
        return;
      }
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare(
        `SELECT lock_mac           AS mac,
                short_mac          AS short,
                lock_state         AS state,
                lock_state_updated AS updatedAt,
                hops               AS hops,
                next_hop_mac       AS nextHopMac,
                next_hop_rssi      AS nextHopRssi,
                link_quality       AS linkQuality,
                wired_voltage      AS wiredVoltage,
                wired_voltage_avg  AS wiredVoltageAvg,
                wired_voltage_min  AS wiredVoltageMin,
                lock_last_seen     AS lockLastSeen
           FROM master_lock_list
          WHERE lock_state IN ('LOCKED','UNLOCKED')`
      ).all() as LockRow[];

      const message: LockStatesMessage = {
        type:     'lock_states',
        bridgeId: opts.bridgeId,
        pollAt:   new Date().toISOString(),
        total:    rows.length,
        locks:    rows,
      };
      opts.ws.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[lock-states] tick error:', (err as Error).message);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
