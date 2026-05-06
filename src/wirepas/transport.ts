/**
 * Serial transport for the Wirepas Dual-MCU API.
 *
 * Owns the UART, handles SLIP framing, correlates request frame IDs with
 * matching confirm primitives, and polls for indications.
 *
 * Default UART config per Wirepas spec: 125000 8N1.
 */

import { EventEmitter } from 'events';
import { RawSerial } from './rawSerial';
import { encodeFrame, decodeStream, DecodedFrame } from './slip';
import { decodePrimitive, DecodedPrimitive, buildIndicationPoll, PRIM } from './frame';

export interface TransportOptions {
  path:     string;
  baudRate?: number;        // default 125000
  pollIntervalMs?: number;  // 0 disables polling (use only if IRQ-driven)
  debug?:   boolean;
}

interface PendingRequest {
  expectPrimitive: number;  // request primitive | 0x80
  frameId:         number;
  resolve:         (p: DecodedPrimitive) => void;
  reject:          (e: Error) => void;
  timer:           NodeJS.Timeout;
}

/**
 * Events:
 *   'frame'      (DecodedFrame)        — every frame, regardless of routing
 *   'primitive'  (DecodedPrimitive)    — every successfully-decoded primitive
 *   'indication' (DecodedPrimitive)    — primitives whose ID is not a confirm we expect
 *   'crcError'   (Buffer)              — frames that failed CRC
 */
export class WirepasTransport extends EventEmitter {
  private port:    RawSerial;
  private rxBuf:   Buffer = Buffer.alloc(0);
  private nextFid: number = 1;
  private pending: Map<string, PendingRequest> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private opts:    Required<Omit<TransportOptions, 'baudRate' | 'pollIntervalMs' | 'debug'>> & {
    baudRate: number;
    pollIntervalMs: number;
    debug: boolean;
  };

  constructor(opts: TransportOptions) {
    super();
    this.opts = {
      path:           opts.path,
      baudRate:       opts.baudRate       ?? 125_000,
      pollIntervalMs: opts.pollIntervalMs ?? 200,
      debug:          opts.debug          ?? false,
    };
    this.port = new RawSerial({
      path:     this.opts.path,
      baudRate: this.opts.baudRate,
      debug:    this.opts.debug,
    });
    this.port.on('data',  (chunk: Buffer) => this.onData(chunk));
    this.port.on('error', (err: Error)    => this.emit('error', err));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => err ? reject(err) : resolve());
    });
  }

  async close(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('transport closing'));
    }
    this.pending.clear();
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) return resolve();
      this.port.close((err) => err ? reject(err) : resolve());
    });
  }

  startPolling(): void {
    if (this.pollTimer || this.opts.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollIndications().catch(() => { /* swallow; emitted on 'error' */ });
    }, this.opts.pollIntervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  /** Allocate the next frame ID (1..255, wrapping; never 0). */
  private allocFrameId(): number {
    const id = this.nextFid;
    this.nextFid = (this.nextFid % 255) + 1;
    return id;
  }

  /**
   * Send a built primitive (3-byte header + payload, no CRC, no SLIP) and wait
   * for the matching confirm. The frame ID inside `frame` MUST be allocFrameId-issued.
   */
  request(frame: Buffer, timeoutMs = 1500): Promise<DecodedPrimitive> {
    if (frame.length < 3) return Promise.reject(new Error('frame too short'));
    const reqPrim = frame[0];
    const fid     = frame[1];
    const expectPrimitive = reqPrim | 0x80;
    const key     = `${expectPrimitive.toString(16)}:${fid.toString(16)}`;
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`fid ${fid} already pending for prim 0x${reqPrim.toString(16)}`));
    }

    const wire = encodeFrame(frame);
    if (this.opts.debug) console.log(`[wp tx] ${wire.toString('hex')}`);

    return new Promise<DecodedPrimitive>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`timeout waiting for confirm (prim=0x${expectPrimitive.toString(16)} fid=${fid})`));
      }, timeoutMs);

      this.pending.set(key, { expectPrimitive, frameId: fid, resolve, reject, timer });

      this.port.write(wire, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(err);
        }
      });
    });
  }

  /** Convenience: build a request with a fresh frame ID. Caller passes a builder fn. */
  async send(builder: (frameId: number) => Buffer, timeoutMs?: number): Promise<DecodedPrimitive> {
    const fid = this.allocFrameId();
    return this.request(builder(fid), timeoutMs);
  }

  async pollIndications(): Promise<void> {
    const fid = this.allocFrameId();
    const confirm = await this.request(buildIndicationPoll(fid), 800);
    // Confirm payload: byte 0 = result. 0=no pending, 1=indications follow.
    // The actual indication primitives arrive as separate frames, handled by onData.
    if (this.opts.debug) {
      console.log(`[wp poll] confirm result=${confirm.payload[0] ?? '?'}`);
    }
  }

  private onData(chunk: Buffer): void {
    if (this.opts.debug) console.log(`[wp rx] ${chunk.toString('hex')}`);
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    const { frames, leftover } = decodeStream(this.rxBuf);
    this.rxBuf = leftover;
    for (const f of frames) this.routeFrame(f);
  }

  private routeFrame(f: DecodedFrame): void {
    this.emit('frame', f);
    if (!f.crcOk) { this.emit('crcError', f.payload); return; }
    const prim = decodePrimitive(f.payload);
    if (!prim) return;
    this.emit('primitive', prim);

    // Confirms have MSB set. Match against pending requests.
    if ((prim.primitive & 0x80) !== 0) {
      const key = `${prim.primitive.toString(16)}:${prim.frameId.toString(16)}`;
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.resolve(prim);
        return;
      }
    }
    // Indications (0x02, 0x03, etc.) and unmatched confirms fall through.
    this.emit('indication', prim);
  }
}
