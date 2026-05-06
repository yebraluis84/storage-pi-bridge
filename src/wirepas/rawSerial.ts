/**
 * Minimal raw serial wrapper — no native bindings.
 *
 * The `serialport` npm package's prebuilt @serialport/bindings-cpp binary
 * for armv7 requires GLIBC_2.28; the gateway runs Ubuntu 16.04 with GLIBC_2.23.
 * Since we only target one OS (Linux on the gateway) we don't need a portable
 * serial library — we just configure the tty with `stty` and open the char
 * device with `fs`.
 *
 * Exposes the same surface our transport needs: `open`, `write`, `close`,
 * and a `'data'` event emitting Buffers.
 */

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';

export interface RawSerialOptions {
  path:     string;
  baudRate: number;
  /** Print the stty invocation we run. */
  debug?: boolean;
}

export class RawSerial extends EventEmitter {
  readonly path:     string;
  readonly baudRate: number;
  private  debug:    boolean;
  private  fd:        number = -1;
  private  pollTimer: NodeJS.Timeout | null = null;
  private  rxBuf:     Buffer = Buffer.alloc(4096);
  private  _isOpen:   boolean = false;

  constructor(opts: RawSerialOptions) {
    super();
    this.path     = opts.path;
    this.baudRate = opts.baudRate;
    this.debug    = opts.debug ?? false;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(cb?: (err?: Error | null) => void): void {
    const done = cb ?? (() => {});
    try {
      // Configure the tty. For non-standard bauds (e.g. Wirepas's 125000)
      // stty can't accept the rate directly, so we use the kernel's
      // spd_cust trick: setserial with baud_base/divisor, then stty 38400.
      this.configureBaud(this.baudRate);

      // O_NONBLOCK + we explicitly poll via fs.read. fs.createReadStream
      // doesn't reliably emit 'data' for character devices in Node 16/20.
      this.fd = fs.openSync(
        this.path,
        fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK,
      );

      this._isOpen = true;
      this.pollTimer = setInterval(() => this.pump(), 20);
      done(null);
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)));
    }
  }

  write(data: Buffer | Uint8Array, cb?: (err?: Error | null) => void): void {
    const done = cb ?? (() => {});
    if (!this._isOpen) return done(new Error('not open'));
    fs.write(this.fd, Buffer.from(data), 0, data.length, null, (err) => done(err ?? null));
  }

  /**
   * Set the line to the requested baud. For rates `stty` accepts directly
   * (115200, 230400, 460800, 921600, 1000000, etc.) we set them straight.
   * For non-standard rates (e.g. Wirepas's 125000) we use Linux's spd_cust
   * trick: setserial picks a divisor against the UART's baud_base, then we
   * tell stty 38400 — the kernel substitutes the custom rate.
   */
  private configureBaud(baud: number): void {
    const STANDARD = new Set([
      50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 9600,
      19200, 38400, 57600, 115200, 230400, 460800, 500000, 576000, 921600,
      1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000,
    ]);

    let lineBaud: number = baud;

    if (!STANDARD.has(baud)) {
      // Non-standard baud — drive it through spd_cust + stty 38400.
      // Discover the UART's baud_base via setserial -a.
      const a = spawnSync('setserial', ['-a', this.path]);
      if (a.status !== 0) {
        throw new Error(`setserial -a ${this.path} failed: ${a.stderr?.toString().trim()}`);
      }
      const m = a.stdout.toString().match(/Baud_base:\s*(\d+)/);
      if (!m) throw new Error(`could not parse Baud_base from setserial output:\n${a.stdout}`);
      const baudBase = Number(m[1]);
      if (baudBase % baud !== 0) {
        throw new Error(`baud ${baud} not realizable from baud_base=${baudBase} (non-integer divisor)`);
      }
      const divisor = baudBase / baud;
      if (this.debug) console.log(`[raw-serial] setserial baud_base=${baudBase} divisor=${divisor} -> ${baud} baud`);
      const s = spawnSync('setserial', [
        this.path, 'baud_base', String(baudBase), 'divisor', String(divisor), 'spd_cust',
      ]);
      if (s.status !== 0) {
        throw new Error(`setserial spd_cust failed: ${s.stderr?.toString().trim()}`);
      }
      lineBaud = 38400; // tell stty 38400; kernel substitutes our custom rate
    } else {
      // Standard baud — make sure no leftover spd_cust is in effect.
      spawnSync('setserial', [this.path, 'spd_normal']);
    }

    const args = [
      '-F', this.path, 'raw', '-echo', String(lineBaud),
      'cs8', '-cstopb', '-parenb', '-ixon', '-ixoff', '-crtscts',
    ];
    if (this.debug) console.log('[raw-serial] stty', args.join(' '));
    const r = spawnSync('stty', args);
    if (r.status !== 0) {
      throw new Error(`stty failed (status=${r.status}): ${r.stderr?.toString().trim() || r.stdout?.toString().trim()}`);
    }
  }

  close(cb?: (err?: Error | null) => void): void {
    const done = cb ?? (() => {});
    if (!this._isOpen) return done(null);
    this._isOpen = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try {
      if (this.fd >= 0) fs.closeSync(this.fd);
      this.fd = -1;
      done(null);
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Polled non-blocking read. Emits 'data' for any bytes available. */
  private pump(): void {
    if (!this._isOpen || this.fd < 0) return;
    try {
      const n = fs.readSync(this.fd, this.rxBuf, 0, this.rxBuf.length, null);
      if (n > 0) this.emit('data', Buffer.from(this.rxBuf.subarray(0, n)));
    } catch (e: any) {
      // EAGAIN/EWOULDBLOCK is the normal "no data right now" case
      if (e?.code !== 'EAGAIN' && e?.code !== 'EWOULDBLOCK') this.emit('error', e);
    }
  }
}
