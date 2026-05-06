/**
 * Wirepas Dual-MCU API frame layer.
 *
 * After SLIP decoding, every frame has the same header:
 *   offset 0: primitive ID  (MSB=0 for request/indication, MSB=1 for confirm/response)
 *   offset 1: frame ID      (caller-chosen, echoed in confirm)
 *   offset 2: payload length (excludes the 2-byte CRC)
 *   offset 3..: primitive-specific payload
 *
 * Multi-byte fields are little-endian.
 *
 * This file only implements the primitives we actually need:
 *   - DSAP-DATA_TX.request / .confirm / .indication (send/receive app data)
 *   - DSAP-DATA_RX.indication                       (receive from a node)
 *   - MSAP-INDICATION_POLL.request / .confirm        (drain pending indications)
 *   - MSAP-STACK_START / STACK_STOP                  (control)
 *   - MSAP-ATTRIBUTE_READ                            (e.g. own node address)
 *   - CSAP-ATTRIBUTE_READ                            (network address/keys)
 */

export const PRIM = {
  DSAP_DATA_TX_REQ:        0x01,
  DSAP_DATA_TX_CONFIRM:    0x81,
  DSAP_DATA_TX_INDICATION: 0x02, // delivered/buffered indication
  DSAP_DATA_RX_INDICATION: 0x03,
  MSAP_INDICATION_POLL_REQ:     0x04,
  MSAP_INDICATION_POLL_CONFIRM: 0x84,
  MSAP_STACK_START_REQ:     0x05,
  MSAP_STACK_START_CONFIRM: 0x85,
  MSAP_STACK_STOP_REQ:      0x06,
  MSAP_STACK_STOP_CONFIRM:  0x86,
  MSAP_ATTR_READ_REQ:       0x0c,
  MSAP_ATTR_READ_CONFIRM:   0x8c,
  MSAP_ATTR_WRITE_REQ:      0x0b,
  MSAP_ATTR_WRITE_CONFIRM:  0x8b,
  CSAP_ATTR_READ_REQ:       0x0e,
  CSAP_ATTR_READ_CONFIRM:   0x8e,
  CSAP_ATTR_WRITE_REQ:      0x0d,
  CSAP_ATTR_WRITE_CONFIRM:  0x8d,
} as const;

export const PRIM_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(PRIM).map(([k, v]) => [v, k] as const),
);

/** MSAP attribute IDs we care about (subset). */
export const MSAP_ATTR = {
  STACK_STATUS:    1,
  PDU_BUFFER_USAGE: 2,
  PDU_BUFFER_CAPACITY: 3,
  SCRATCHPAD_NUM_BYTES: 4,
  ROUTE_COUNT:     12,
} as const;

/** CSAP attribute IDs (subset). */
export const CSAP_ATTR = {
  NODE_ADDRESS:        1,
  NETWORK_ADDRESS:     2,
  NETWORK_CHANNEL:     3,
  NODE_ROLE:           4,
  MTU:                 5,
  PDU_BUFFER_SIZE:     6,
  SCRATCHPAD_SIZE:     7,
  MESH_API_VERSION:    8,
  FIRMWARE_MAJOR:      9,
  FIRMWARE_MINOR:     10,
  FIRMWARE_MAINTENANCE: 11,
  FIRMWARE_DEVELOPMENT: 12,
  CIPHER_KEY:         13,
  AUTHENTICATION_KEY: 14,
  CHANNEL_LIMITS:     15,
  APP_CONFIG_DATA_SIZE: 16,
  HW_MAGIC:           17,
  STACK_PROFILE:      18,
} as const;

/** Build the common 3-byte header + payload, ready for slip.encodeFrame(). */
export function buildPrimitive(primitiveId: number, frameId: number, payload: Uint8Array | Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 0xff) throw new Error(`payload too large: ${payload.length} bytes (max 255)`);
  const out = Buffer.alloc(3 + payload.length);
  out[0] = primitiveId & 0xff;
  out[1] = frameId & 0xff;
  out[2] = payload.length & 0xff;
  Buffer.from(payload).copy(out, 3);
  return out;
}

export interface DecodedPrimitive {
  primitive: number;
  primitiveName: string;
  frameId: number;
  length: number;
  payload: Buffer;
}

export function decodePrimitive(raw: Buffer): DecodedPrimitive | null {
  if (raw.length < 3) return null;
  const primitive = raw[0];
  const frameId   = raw[1];
  const length    = raw[2];
  if (raw.length < 3 + length) return null;
  return {
    primitive,
    primitiveName: PRIM_NAME[primitive] ?? `0x${primitive.toString(16).padStart(2, '0')}`,
    frameId,
    length,
    payload: raw.subarray(3, 3 + length),
  };
}

// ---- DSAP-DATA_TX.request ---------------------------------------------------
// payload layout (per DualMcuAPI.md):
//   0..1   PDU ID (LE) — caller-chosen, echoed in TX indication
//   2      source endpoint
//   3..6   destination address (LE)
//   7      destination endpoint
//   8      QoS (0=normal, 1=high)
//   9      TX options (bit 0: request indication; bits 2..5: hop limit override)
//   10     APDU length (1..102)
//   11..   APDU bytes

export interface DataTxOptions {
  pduId:           number;       // 16-bit
  sourceEndpoint:  number;
  destAddress:     number;       // 32-bit LE
  destEndpoint:    number;
  qos?:            0 | 1;
  requestTxIndication?: boolean;
  hopLimit?:       number;       // 0..15 (0 = network default)
  apdu:            Uint8Array | Buffer;
}

export function buildDsapDataTx(frameId: number, opts: DataTxOptions): Buffer {
  if (opts.apdu.length < 1 || opts.apdu.length > 102) {
    throw new Error(`APDU length must be 1..102, got ${opts.apdu.length}`);
  }
  const txOptions =
    (opts.requestTxIndication ? 0x01 : 0x00) |
    (((opts.hopLimit ?? 0) & 0x0f) << 2);

  const pl = Buffer.alloc(11 + opts.apdu.length);
  pl.writeUInt16LE(opts.pduId & 0xffff, 0);
  pl[2] = opts.sourceEndpoint & 0xff;
  pl.writeUInt32LE(opts.destAddress >>> 0, 3);
  pl[7] = opts.destEndpoint & 0xff;
  pl[8] = (opts.qos ?? 0) & 0x01;
  pl[9] = txOptions & 0xff;
  pl[10] = opts.apdu.length & 0xff;
  Buffer.from(opts.apdu).copy(pl, 11);

  return buildPrimitive(PRIM.DSAP_DATA_TX_REQ, frameId, pl);
}

// ---- DSAP-DATA_RX.indication ------------------------------------------------
// payload layout:
//   0      indication status (bit 0: more queued)
//   1..4   source address (LE)
//   5      source endpoint
//   6..9   destination address (LE)
//   10     destination endpoint
//   11     bits 0..1 = QoS,  bits 2..7 = hop count
//   12..15 travel time (LE, 1/128 s ticks)
//   16     APDU length
//   17..   APDU bytes

export interface DataRxIndication {
  moreQueued:   boolean;
  srcAddress:   number;
  srcEndpoint:  number;
  dstAddress:   number;
  dstEndpoint:  number;
  qos:          number;
  hopCount:     number;
  travelTimeMs: number;
  apdu:         Buffer;
}

export function parseDsapDataRx(payload: Buffer): DataRxIndication | null {
  if (payload.length < 17) return null;
  const apduLen = payload[16];
  if (payload.length < 17 + apduLen) return null;
  const qosHop = payload[11];
  const ticks  = payload.readUInt32LE(12);
  return {
    moreQueued:   (payload[0] & 0x01) !== 0,
    srcAddress:   payload.readUInt32LE(1),
    srcEndpoint:  payload[5],
    dstAddress:   payload.readUInt32LE(6),
    dstEndpoint:  payload[10],
    qos:          qosHop & 0x03,
    hopCount:     (qosHop >> 2) & 0x3f,
    travelTimeMs: Math.round((ticks * 1000) / 128),
    apdu:         payload.subarray(17, 17 + apduLen),
  };
}

// ---- MSAP / CSAP attribute read --------------------------------------------

export function buildMsapAttrRead(frameId: number, attrId: number): Buffer {
  const pl = Buffer.alloc(2);
  pl.writeUInt16LE(attrId & 0xffff, 0);
  return buildPrimitive(PRIM.MSAP_ATTR_READ_REQ, frameId, pl);
}
export function buildCsapAttrRead(frameId: number, attrId: number): Buffer {
  const pl = Buffer.alloc(2);
  pl.writeUInt16LE(attrId & 0xffff, 0);
  return buildPrimitive(PRIM.CSAP_ATTR_READ_REQ, frameId, pl);
}

// ---- MSAP indication poll / stack control ----------------------------------

export function buildIndicationPoll(frameId: number): Buffer {
  return buildPrimitive(PRIM.MSAP_INDICATION_POLL_REQ, frameId);
}
export function buildStackStart(frameId: number, autostart = true): Buffer {
  return buildPrimitive(PRIM.MSAP_STACK_START_REQ, frameId, Buffer.from([autostart ? 0x01 : 0x00]));
}
export function buildStackStop(frameId: number): Buffer {
  return buildPrimitive(PRIM.MSAP_STACK_STOP_REQ, frameId);
}
