/**
 * SLIP framing + CRC-16-CCITT for Wirepas Dual-MCU API.
 *
 * Source of truth: wirepas/c-mesh-api lib/wpc/slip.c
 *   - END_SLIP_OCTET   = 0xC0   (frame delimiter)
 *   - ESC_SLIP_OCTET   = 0xDB
 *   - END_SUBS_OCTET   = 0xDC   (escapes embedded END)
 *   - ESC_SUBS_OCTET   = 0xDD   (escapes embedded ESC)
 *   - 3x END prepended, 1x END appended on send (extra ENDs are wake-up)
 *   - CRC computed on the raw (pre-SLIP-encoding) payload, appended LE
 *
 * CRC-16-CCITT (XMODEM-style):
 *   poly 0x1021, init 0xFFFF, no reflection in/out, no final XOR.
 */

export const SLIP_END      = 0xc0;
export const SLIP_ESC      = 0xdb;
export const SLIP_ESC_END  = 0xdc;
export const SLIP_ESC_ESC  = 0xdd;

export function crc16Ccitt(data: Uint8Array | Buffer): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Encode a payload as a SLIP frame ready to write to the UART.
 * Appends CRC-16 (LE), then SLIP-encodes everything, then brackets with ENDs.
 */
export function encodeFrame(payload: Uint8Array | Buffer): Buffer {
  const crc = crc16Ccitt(payload);
  const withCrc = Buffer.alloc(payload.length + 2);
  Buffer.from(payload).copy(withCrc, 0);
  withCrc[payload.length]     = crc        & 0xff;  // LE low byte first
  withCrc[payload.length + 1] = (crc >> 8) & 0xff;

  // Worst-case escape doubles every byte
  const escaped: number[] = [];
  for (const b of withCrc) {
    if (b === SLIP_END)      escaped.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) escaped.push(SLIP_ESC, SLIP_ESC_ESC);
    else                     escaped.push(b);
  }

  // 3x END prepended (host->stack wake-up), 1x END appended
  return Buffer.from([SLIP_END, SLIP_END, SLIP_END, ...escaped, SLIP_END]);
}

export interface DecodedFrame {
  /** raw, un-escaped, CRC-stripped payload */
  payload: Buffer;
  crcOk:   boolean;
  /** start offset into the input buffer (for diagnostics) */
  start:   number;
  /** end offset (exclusive) — past the closing END */
  end:     number;
}

/**
 * Stream-tolerant SLIP decoder. Scans `input` for END-delimited frames,
 * un-escapes, validates CRC, and yields one DecodedFrame per frame found.
 * Garbage between frames is skipped silently. Trailing partial-frame bytes
 * are NOT consumed — caller can buffer them and prepend on next call.
 *
 * Returns: { frames, leftover } where leftover is the unparsed tail.
 */
export function decodeStream(input: Buffer): { frames: DecodedFrame[]; leftover: Buffer } {
  const frames: DecodedFrame[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip leading ENDs and any garbage until we find the first non-END after an END
    while (i < input.length && input[i] === SLIP_END) i++;
    const frameStart = i;
    if (i >= input.length) break;

    // Collect un-escaped bytes until the next END
    const buf: number[] = [];
    let escapeNext = false;
    while (i < input.length && input[i] !== SLIP_END) {
      const b = input[i];
      if (escapeNext) {
        if (b === SLIP_ESC_END)      buf.push(SLIP_END);
        else if (b === SLIP_ESC_ESC) buf.push(SLIP_ESC);
        else                         buf.push(b); // protocol violation; pass through
        escapeNext = false;
      } else if (b === SLIP_ESC) {
        escapeNext = true;
      } else {
        buf.push(b);
      }
      i++;
    }

    if (i >= input.length) {
      // Hit end-of-buffer mid-frame — preserve the unparsed tail
      return { frames, leftover: input.subarray(frameStart) };
    }

    // i now points at the closing END. Validate frame.
    if (buf.length >= 5) { // 1 prim + 1 fid + 1 len + 0+ payload + 2 crc
      const raw = Buffer.from(buf);
      const dataLen = raw.length - 2;
      const got = raw.readUInt16LE(dataLen);
      const expect = crc16Ccitt(raw.subarray(0, dataLen));
      frames.push({
        payload: raw.subarray(0, dataLen),
        crcOk:   got === expect,
        start:   frameStart,
        end:     i + 1,
      });
    }
    i++; // step past the closing END
  }

  return { frames, leftover: Buffer.alloc(0) };
}
