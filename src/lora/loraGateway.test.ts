/**
 * Drives LoraGateway against a fake serial port that behaves like the
 * synch-latch-firmware gateway. No hardware needed: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { LoraGateway, SerialLike } from './loraGateway';

class FakePort extends EventEmitter implements SerialLike {
  isOpen = false;
  written: string[] = [];
  /** Scripted replies: command prefix -> lines the "firmware" prints back. */
  replies: Array<{ match: RegExp; lines: string[] | ((cmd: string) => string[]) }> = [];
  failOpen = false;

  open(cb: (err?: Error | null) => void) {
    if (this.failOpen) return cb(new Error('ENOENT'));
    this.isOpen = true; cb(null);
  }
  write(data: Buffer, cb: (err?: Error | null) => void) {
    const cmd = data.toString('ascii').trim();
    this.written.push(cmd);
    cb(null);
    for (const r of this.replies) {
      if (r.match.test(cmd)) {
        const lines = typeof r.lines === 'function' ? r.lines(cmd) : r.lines;
        setImmediate(() => this.feed(lines.join('\n') + '\n'));
        break;
      }
    }
  }
  close(cb: (err?: Error | null) => void) { this.isOpen = false; cb(null); }
  feed(text: string) { this.emit('data', Buffer.from(text, 'utf8')); }
  // split one line across two chunks to prove reassembly works
  feedSplit(line: string) {
    const mid = Math.floor(line.length / 2);
    this.emit('data', Buffer.from(line.slice(0, mid)));
    this.emit('data', Buffer.from(line.slice(mid) + '\n'));
  }
}

function firmwareLike(): FakePort {
  const p = new FakePort();
  p.replies.push({ match: /^HELLO$/, lines: ['OK SYNCH-GW 0.1 ready'] });
  p.replies.push({ match: /^PING (\d+) (\d+)$/, lines: (cmd) => {
    const [, id, ctr] = cmd.match(/^PING (\d+) (\d+)$/)!;
    return [`TX ping id=${id} ctr=${ctr}`, `RX type=pong id=${id} bolt=locked mismatch=0 fired=0 uptime=3m rssi=-55 snr=8.0 ctr=9`];
  }});
  p.replies.push({ match: /^UNLOCK (\d+) (\d+)$/, lines: (cmd) => {
    const [, id, ctr] = cmd.match(/^UNLOCK (\d+) (\d+)$/)!;
    return [`TX unlock id=${id} ctr=${ctr}`,
            // a heartbeat from another latch sneaks in first
            `RX type=status id=99 bolt=locked mismatch=0 fired=0 uptime=1m rssi=-80 snr=2.0 ctr=1`,
            `RX type=status id=${id} bolt=open mismatch=0 fired=1 uptime=3m rssi=-56 snr=7.5 ctr=10`];
  }});
  return p;
}

function makeGw(port: FakePort, extra: Partial<ConstructorParameters<typeof LoraGateway>[0]> = {}) {
  return new LoraGateway({ path: '/dev/fake', reopenMs: 20, portFactory: () => port, ...extra });
}

const ready = (gw: LoraGateway) => new Promise<string>((res) => gw.once('ready', res));

test('HELLO handshake marks the gateway ready', async (t) => {
  const port = firmwareLike();
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.start();
  const fw = await ready(gw);
  assert.equal(fw, 'SYNCH-GW 0.1');
  assert.equal(gw.ready, true);
  assert.equal(port.written[0], 'HELLO');
  gw.stop();
});

test('ping resolves on the pong for that latch only', async (t) => {
  const port = firmwareLike();
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.start(); await ready(gw);
  const st = await gw.ping(7);
  assert.equal(st.latchId, 7);
  assert.equal(st.type, 'pong');
  assert.equal(st.bolt, 'locked');
  assert.match(port.written[1], /^PING 7 \d{10}$/);
  gw.stop();
});

test('unlock waits for fired=1 from the right latch and forwards every status', async (t) => {
  const port = firmwareLike();
  const gw = makeGw(port); t.after(() => gw.stop());
  const seen: number[] = [];
  gw.on('status', (s) => seen.push(s.latchId));
  gw.start(); await ready(gw);
  const st = await gw.unlock(3);
  assert.equal(st.latchId, 3);
  assert.equal(st.fired, true);
  assert.equal(st.bolt, 'open');
  assert.deepEqual(seen, [99, 3]);   // heartbeat from latch 99 was emitted, not swallowed
  gw.stop();
});

test('counter is strictly increasing even inside one second', async () => {
  const gw = makeGw(firmwareLike());
  const a = gw.nextCounter(), b = gw.nextCounter(), c = gw.nextCounter();
  assert.ok(b > a && c > b);
  assert.ok(a >= Math.floor(Date.now() / 1000) - 1);
});

test('second command to the same latch while one is in flight is rejected', async (t) => {
  const port = firmwareLike();
  port.replies = port.replies.filter(r => !/UNLOCK/.test(String(r.match)));   // firmware never answers
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.start(); await ready(gw);
  const first = gw.unlock(5, 200);
  await assert.rejects(gw.unlock(5, 200), /already has a command in flight/);
  await assert.rejects(first, /did not answer within 200 ms/);
  gw.stop();
});

test('ERR from the firmware fails the pending command', async (t) => {
  const port = firmwareLike();
  port.replies.unshift({ match: /^UNLOCK/, lines: ['ERR usage: UNLOCK <id 1-65535> <counter>'] });
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.start(); await ready(gw);
  await assert.rejects(gw.unlock(1), /gateway: usage/);
  gw.stop();
});

test('raw() derives latch id and expectation from the packet bytes', async (t) => {
  const port = firmwareLike();
  port.replies.push({ match: /^RAW /, lines: ['TX raw id=1', 'RX type=pong id=1 bolt=locked mismatch=0 fired=0 uptime=0m rssi=-50 snr=9.0 ctr=2'] });
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.start(); await ready(gw);
  // magic 'S', ver 1, dst=1 (LE), src=0, type=3 (PING), reserved, counter, 8 payload, 8 mac
  const hex = '53' + '01' + '0100' + '0000' + '03' + '00' + '00000000' + '00'.repeat(8) + '00'.repeat(8);
  assert.equal(hex.length, 56);
  const st = await gw.raw(hex);
  assert.equal(st.type, 'pong');
  assert.equal(port.written.at(-1), `RAW ${hex}`);
  await assert.rejects(gw.raw('abcd'), /56 hex chars/);
  gw.stop();
});

test('lines split across chunks are reassembled', async (t) => {
  const port = firmwareLike();
  const gw = makeGw(port); t.after(() => gw.stop());
  const got = new Promise<number>((res) => gw.once('status', (s) => res(s.rssi)));
  gw.start(); await ready(gw);
  port.feedSplit('RX type=status id=4 bolt=open mismatch=0 fired=0 uptime=2m rssi=-63 snr=6.0 ctr=5');
  assert.equal(await got, -63);
  gw.stop();
});

test('reopens after a serial error and the pending command is failed', async (t) => {
  const port = firmwareLike();
  const gw = makeGw(port); t.after(() => gw.stop());
  gw.on('error', () => { /* expected */ });
  gw.start(); await ready(gw);
  const closes: string[] = [];
  gw.on('close', (r) => closes.push(r));
  const p = gw.ping(2, 1000);
  port.emit('error', new Error('EIO'));
  await assert.rejects(p, /serial error: EIO/);
  assert.equal(gw.connected, false);
  await ready(gw);                       // factory hands back the same fake, which reopens
  assert.equal(gw.ready, true);
  assert.ok(closes.some(c => /EIO/.test(c)));
  gw.stop();
});
