/**
 * LoRa gateway driver.
 *
 * Talks to the Synch gateway radio (XIAO nRF52840 + Wio-SX1262 running
 * synch-latch-firmware in ROLE_GATEWAY) over its USB serial port, and turns
 * backend intents ("unlock latch 12") into LoRa packets and back.
 *
 *   [backend] --ws--> [pi-bridge] --/dev/ttyACM0--> [XIAO gateway] --LoRa--> [latch]
 *
 * Responsibilities:
 *   - find and open the port, reopen forever if the radio is unplugged
 *   - HELLO handshake so we know the firmware is really there
 *   - unlock(id) / ping(id) / raw(hex) with per-latch correlation + timeout
 *   - emit every latch report ('status') so index.ts can forward heartbeats
 *   - strictly increasing counter (epoch seconds, bumped if two calls land in
 *     the same second) because the latch rejects anything <= last seen
 *
 * Uses RawSerial (stty + fs) rather than the serialport npm package: the
 * gateways run glibc 2.23 and serialport's prebuilt bindings don't load.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { RawSerial } from '../wirepas/rawSerial';
import { parseGatewayLine, splitLines, LatchStatus } from './parse';

export type { LatchStatus } from './parse';

/** The slice of RawSerial we use. Tests inject a fake through `portFactory`. */
export interface SerialLike {
  readonly isOpen: boolean;
  open(cb: (err?: Error | null) => void): void;
  write(data: Buffer, cb: (err?: Error | null) => void): void;
  close(cb: (err?: Error | null) => void): void;
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  removeAllListeners(): unknown;
}

export interface LoraGatewayOptions {
  path?:        string;   // serial device; auto-detected when omitted
  baudRate?:    number;   // USB CDC ignores it, but stty wants a number
  reopenMs?:    number;   // delay between reopen attempts
  debug?:       boolean;
  portFactory?: (path: string, baudRate: number, debug: boolean) => SerialLike;
}

interface Pending {
  expect:  'pong' | 'fired';
  resolve: (s: LatchStatus) => void;
  reject:  (e: Error) => void;
  timer:   NodeJS.Timeout;
}

const DEFAULT_REOPEN_MS = 5_000;
const HELLO_TIMEOUT_MS  = 3_000;
const HELLO_RETRY_MS    = 10_000;

/**
 * Events:
 *   'open'    (path)          port opened
 *   'ready'   (firmware)      HELLO answered
 *   'close'   (reason)        port closed, will retry
 *   'status'  (LatchStatus)   any RX line from any latch (heartbeats included)
 *   'line'    (string)        every raw line, for debugging
 *   'error'   (Error)
 */
export class LoraGateway extends EventEmitter {
  private port:        SerialLike | null = null;
  private makePort:    NonNullable<LoraGatewayOptions['portFactory']>;
  private rxBuf        = '';
  private pending      = new Map<number, Pending>();
  private helloWaiter: { resolve: (s: string) => void; timer: NodeJS.Timeout } | null = null;
  private helloTimer:  NodeJS.Timeout | null = null;
  private reopenTimer: NodeJS.Timeout | null = null;
  private lastCounter  = 0;
  private stopped      = false;
  private _firmware:   string | null = null;
  private _path:       string | null = null;
  private opts: Required<Omit<LoraGatewayOptions, 'path' | 'portFactory'>> & { path?: string };

  constructor(opts: LoraGatewayOptions = {}) {
    super();
    this.opts = {
      path:     opts.path,
      baudRate: opts.baudRate ?? 115_200,
      reopenMs: opts.reopenMs ?? DEFAULT_REOPEN_MS,
      debug:    opts.debug    ?? false,
    };
    this.makePort = opts.portFactory
      ?? ((path, baudRate, debug) => new RawSerial({ path, baudRate, debug }));
  }

  get connected(): boolean       { return this.port?.isOpen ?? false; }
  get ready(): boolean           { return this.connected && this._firmware !== null; }
  get firmware(): string | null  { return this._firmware; }
  get path(): string | null      { return this._path; }

  // ─── lifecycle ─────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.tryOpen();
  }

  stop(): void {
    this.stopped = true;
    if (this.reopenTimer) { clearTimeout(this.reopenTimer); this.reopenTimer = null; }
    this.teardown('stopped');
  }

  private tryOpen(): void {
    if (this.stopped || this.connected) return;
    const path = this.opts.path ?? findGatewayPort();
    if (!path) {
      this.scheduleReopen('no LoRa gateway serial device found');
      return;
    }
    const port = this.makePort(path, this.opts.baudRate, this.opts.debug);
    port.on('data',  (chunk: Buffer) => this.onData(chunk));
    port.on('error', (err: Error) => {
      this.emit('error', err);
      this.teardown(`serial error: ${err.message}`);
      this.scheduleReopen();
    });
    port.open((err) => {
      if (err) {
        this.scheduleReopen(`open ${path} failed: ${err.message}`);
        return;
      }
      this.port  = port;
      this._path = path;
      this.emit('open', path);
      this.kickHello();
    });
  }

  private scheduleReopen(reason?: string): void {
    if (this.stopped || this.reopenTimer) return;
    if (reason) this.emit('close', reason);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      this.tryOpen();
    }, this.opts.reopenMs);
  }

  private teardown(reason: string): void {
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.helloWaiter) { clearTimeout(this.helloWaiter.timer); this.helloWaiter = null; }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`LoRa gateway ${reason}`));
      this.pending.delete(id);
    }
    const port = this.port;
    this.port = null;
    this._firmware = null;
    this.rxBuf = '';
    if (port) {
      port.removeAllListeners();
      port.close(() => { /* ignore */ });
      this.emit('close', reason);
    }
  }

  /** Send HELLO until the firmware answers; re-arm periodically so a
   *  mid-session radio reboot is noticed. */
  private kickHello(): void {
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    this.hello().then((fw) => {
      if (this._firmware !== fw) this.emit('ready', fw);
      this._firmware = fw;
      this.helloTimer = setTimeout(() => this.kickHello(), HELLO_RETRY_MS * 6);   // re-verify each minute
    }).catch(() => {
      if (this._firmware) this.emit('close', 'firmware stopped answering HELLO');
      this._firmware = null;
      this.helloTimer = setTimeout(() => this.kickHello(), HELLO_RETRY_MS);
    });
  }

  // ─── serial I/O ────────────────────────────────────────────────────

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) return reject(new Error('LoRa gateway not connected'));
      if (this.opts.debug) console.log(`[lora tx] ${line}`);
      this.port.write(Buffer.from(line + '\n', 'ascii'), (err) => err ? reject(err) : resolve());
    });
  }

  private onData(chunk: Buffer): void {
    this.rxBuf += chunk.toString('utf8');
    if (this.rxBuf.length > 8192) this.rxBuf = this.rxBuf.slice(-4096);   // runaway guard
    const { lines, rest } = splitLines(this.rxBuf);
    this.rxBuf = rest;
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    this.emit('line', line);
    if (this.opts.debug) console.log(`[lora rx] ${line}`);
    const parsed = parseGatewayLine(line);
    switch (parsed.kind) {
      case 'ok':
        if (this.helloWaiter && /SYNCH-GW/.test(parsed.text)) {
          clearTimeout(this.helloWaiter.timer);
          const w = this.helloWaiter;
          this.helloWaiter = null;
          w.resolve(parsed.text.replace(/\s*ready$/, ''));
        }
        break;
      case 'err':
        // Fail whatever is pending — the firmware rejected our last command.
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`gateway: ${parsed.text}`));
          this.pending.delete(id);
        }
        break;
      case 'rx': {
        const s = parsed.status;
        this.emit('status', s);
        const p = this.pending.get(s.latchId);
        if (!p) break;
        const hit = p.expect === 'pong' ? s.type === 'pong' : s.fired;
        if (!hit) break;
        clearTimeout(p.timer);
        this.pending.delete(s.latchId);
        p.resolve(s);
        break;
      }
      default:
        break;
    }
  }

  // ─── commands ──────────────────────────────────────────────────────

  /** Epoch seconds, strictly increasing within this process. */
  nextCounter(): number {
    const now = Math.floor(Date.now() / 1000);
    this.lastCounter = Math.max(now, this.lastCounter + 1);
    return this.lastCounter;
  }

  hello(timeoutMs = HELLO_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.helloWaiter) return reject(new Error('HELLO already in flight'));
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        reject(new Error('no answer to HELLO'));
      }, timeoutMs);
      this.helloWaiter = { resolve, timer };
      this.writeLine('HELLO').catch((e) => {
        clearTimeout(timer);
        this.helloWaiter = null;
        reject(e);
      });
    });
  }

  private exchange(latchId: number, expect: Pending['expect'], timeoutMs: number, send: () => Promise<void>): Promise<LatchStatus> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('LoRa gateway not connected'));
      if (this.pending.has(latchId)) return reject(new Error(`latch ${latchId} already has a command in flight`));
      const timer = setTimeout(() => {
        this.pending.delete(latchId);
        reject(new Error(`latch ${latchId} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(latchId, { expect, resolve, reject, timer });
      send().catch((e) => {
        clearTimeout(timer);
        this.pending.delete(latchId);
        reject(e);
      });
    });
  }

  /** Fire the bolt. Resolves with the latch's post-pulse sensor report. */
  unlock(latchId: number, timeoutMs = 8_000): Promise<LatchStatus> {
    checkId(latchId);
    return this.exchange(latchId, 'fired', timeoutMs, () => this.writeLine(`UNLOCK ${latchId} ${this.nextCounter()}`));
  }

  /** Ask the latch for its current state. */
  ping(latchId: number, timeoutMs = 6_000): Promise<LatchStatus> {
    checkId(latchId);
    return this.exchange(latchId, 'pong', timeoutMs, () => this.writeLine(`PING ${latchId} ${this.nextCounter()}`));
  }

  /**
   * Send a packet the backend already signed (56 hex chars). The latch id is
   * bytes 2..3 little-endian; the message type byte 6 decides what we wait for.
   */
  raw(hex: string, timeoutMs = 8_000): Promise<LatchStatus> {
    const clean = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{56}$/.test(clean)) return Promise.reject(new Error('raw packet must be 56 hex chars'));
    const buf     = Buffer.from(clean, 'hex');
    const latchId = buf.readUInt16LE(2);
    const type    = buf[6];
    const expect: Pending['expect'] = type === 3 ? 'pong' : 'fired';
    return this.exchange(latchId, expect, timeoutMs, () => this.writeLine(`RAW ${clean}`));
  }
}

function checkId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > 0xFFFF) throw new Error(`invalid latch id ${id}`);
}

/**
 * Pick the gateway's serial device. Prefers the stable by-id symlink Linux
 * creates for the XIAO's USB CDC interface, falls back to the first ttyACM.
 */
export function findGatewayPort(): string | null {
  const byId = '/dev/serial/by-id';
  try {
    const names = fs.readdirSync(byId);
    const hit = names.find(n => /seeed|xiao|nrf52/i.test(n)) ?? names.find(n => /ACM|usb/i.test(n));
    if (hit) return `${byId}/${hit}`;
  } catch { /* no by-id dir */ }
  try {
    const acm = fs.readdirSync('/dev').filter(n => /^ttyACM\d+$/.test(n)).sort();
    if (acm.length) return `/dev/${acm[0]}`;
  } catch { /* ignore */ }
  return null;
}
