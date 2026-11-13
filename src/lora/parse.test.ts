import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGatewayLine, splitLines } from './parse';

const NOW = new Date('2026-11-13T00:00:00Z');

test('parses a status line', () => {
  const r = parseGatewayLine('RX type=status id=1 bolt=open mismatch=0 fired=1 uptime=12m rssi=-71 snr=9.5 ctr=42', NOW);
  assert.equal(r.kind, 'rx');
  if (r.kind !== 'rx') return;
  assert.deepEqual(r.status, {
    latchId: 1, type: 'status', bolt: 'open', mismatch: false, fired: true,
    uptimeMin: 12, rssi: -71, snr: 9.5, counter: 42, at: NOW.toISOString(),
  });
});

test('parses a pong with mismatch', () => {
  const r = parseGatewayLine('RX type=pong id=7 bolt=locked mismatch=1 fired=0 uptime=0m rssi=-40 snr=11.2 ctr=3', NOW);
  assert.equal(r.kind, 'rx');
  if (r.kind !== 'rx') return;
  assert.equal(r.status.type, 'pong');
  assert.equal(r.status.latchId, 7);
  assert.equal(r.status.bolt, 'locked');
  assert.equal(r.status.mismatch, true);
});

test('parses TX / OK / ERR / HEX / log', () => {
  assert.deepEqual(parseGatewayLine('TX unlock id=3 ctr=1794511220'), { kind: 'tx', what: 'unlock', latchId: 3, counter: 1794511220 });
  assert.deepEqual(parseGatewayLine('OK SYNCH-GW 0.1 ready'),          { kind: 'ok', text: 'SYNCH-GW 0.1 ready' });
  assert.deepEqual(parseGatewayLine('ERR unknown command'),            { kind: 'err', text: 'unknown command' });
  assert.deepEqual(parseGatewayLine('HEX 5301abcd'),                   { kind: 'hex', hex: '5301abcd' });
  assert.deepEqual(parseGatewayLine('[radio] up\r'),                   { kind: 'log', text: '[radio] up' });
});

test('splitLines keeps the partial tail', () => {
  const { lines, rest } = splitLines('OK a\r\nRX type=status id=1\nHEX 53');
  assert.deepEqual(lines, ['OK a', 'RX type=status id=1']);
  assert.equal(rest, 'HEX 53');
});
