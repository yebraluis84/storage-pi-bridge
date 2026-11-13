/**
 * Parser for the Synch LoRa gateway's serial line protocol.
 *
 * The gateway is a XIAO nRF52840 + Wio-SX1262 running synch-latch-firmware
 * in ROLE_GATEWAY. It speaks newline-terminated ASCII at 115200:
 *
 *   OK SYNCH-GW 0.1 ready
 *   TX unlock id=1 ctr=1794511220
 *   RX type=status id=1 bolt=open mismatch=0 fired=1 uptime=12m rssi=-71 snr=9.5 ctr=42
 *   HEX 5301...
 *   ERR usage: UNLOCK <id 1-65535> <counter>
 *   [radio] up                      (free-form log lines from the firmware)
 *
 * Pure functions only, so this file is unit-testable without hardware.
 */

export interface LatchStatus {
  latchId:   number;
  type:      'status' | 'pong';
  bolt:      'open' | 'locked';
  mismatch:  boolean;   // fired but the sensor still says locked
  fired:     boolean;   // this report follows a bolt pulse
  uptimeMin: number;
  rssi:      number;    // dBm as heard by the gateway
  snr:       number;    // dB
  counter:   number;    // latch's own tx counter
  at:        string;    // ISO timestamp, when the bridge parsed it
}

export type GatewayLine =
  | { kind: 'ok';   text: string }
  | { kind: 'err';  text: string }
  | { kind: 'tx';   what: string; latchId: number; counter: number }
  | { kind: 'rx';   status: LatchStatus }
  | { kind: 'hex';  hex: string }
  | { kind: 'log';  text: string };

function kv(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of rest.trim().split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

export function parseGatewayLine(raw: string, now: Date = new Date()): GatewayLine {
  const line = raw.trim();

  if (line.startsWith('OK '))  return { kind: 'ok',  text: line.slice(3) };
  if (line.startsWith('ERR ')) return { kind: 'err', text: line.slice(4) };
  if (line.startsWith('HEX ')) return { kind: 'hex', hex: line.slice(4).trim() };

  if (line.startsWith('TX ')) {
    const parts = line.slice(3).trim().split(/\s+/);
    const f = kv(parts.slice(1).join(' '));
    return {
      kind:    'tx',
      what:    parts[0] ?? '',
      latchId: Number(f.id ?? 0),
      counter: Number(f.ctr ?? 0),
    };
  }

  if (line.startsWith('RX ')) {
    const f = kv(line.slice(3));
    const type = f.type === 'pong' ? 'pong' : 'status';
    return {
      kind: 'rx',
      status: {
        latchId:   Number(f.id ?? 0),
        type,
        bolt:      f.bolt === 'open' ? 'open' : 'locked',
        mismatch:  f.mismatch === '1',
        fired:     f.fired === '1',
        uptimeMin: Number((f.uptime ?? '0').replace(/m$/, '')),
        rssi:      Number(f.rssi ?? 0),
        snr:       Number(f.snr ?? 0),
        counter:   Number(f.ctr ?? 0),
        at:        now.toISOString(),
      },
    };
  }

  return { kind: 'log', text: line };
}

/** Split a byte stream into complete lines; returns leftover partial line. */
export function splitLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split(/\r?\n/);
  const rest  = parts.pop() ?? '';
  return { lines: parts.filter(l => l.length > 0), rest };
}
