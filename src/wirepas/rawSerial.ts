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
  private  fd:       number = -1;
  private  reader:   fs.ReadStream | null = null;
  private  _isOpen:  boolean = false;

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
      // Configure the tty: raw mode, requested baud, 8N1, no flow control.
      const args = [
        '-F', this.path, 'raw', '-echo', String(this.baudRate),
        'cs8', '-cstopb', '-parenb', '-ixon', '-ixoff', '-crtscts',
      ];
      if (this.debug) console.log('[raw-serial] stty', args.join(' '));
      const r = spawnSync('stty', args);
      if (r.status !== 0) {
        return done(new Error(
          `stty failed (status=${r.status}): ${r.stderr?.toString().trim() || r.stdout?.toString().trim()}`,
        ));
      }

      // O_NONBLOCK so libuv can poll it without blocking the event loop.
      this.fd = fs.openSync(
        this.path,
        fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK,
      );

      // ReadStream backed by the fd; autoClose=false because we own the fd.
      this.reader = fs.createReadStream('', { fd: this.fd, autoClose: false, highWaterMark: 256 });
      this.reader.on('data', (chunk: Buffer | string) => {
        this.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      this.reader.on('error', (e) => this.emit('error', e));

      this._isOpen = true;
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

  close(cb?: (err?: Error | null) => void): void {
    const done = cb ?? (() => {});
    if (!this._isOpen) return done(null);
    this._isOpen = false;
    try { this.reader?.destroy(); } catch {}
    this.reader = null;
    try {
      if (this.fd >= 0) fs.closeSync(this.fd);
      this.fd = -1;
      done(null);
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
