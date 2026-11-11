import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isIPv4, looksLikeCompanionBox, mergeFound, parseDiscoveryReply, scanHosts, subnetBroadcast, subnetCandidates, DISCOVERY_REPLY_MAGIC,
} from '../src/lib/discovery.ts';

test('isIPv4 accepts dotted quads only', () => {
  assert.equal(isIPv4('192.168.1.20'), true);
  assert.equal(isIPv4('256.1.1.1'), false);
  assert.equal(isIPv4('::1'), false);
  assert.equal(isIPv4('10.0.0'), false);
  assert.equal(isIPv4('a.b.c.d'), false);
});

test('subnetCandidates lists the /24 without the phone itself, nearest first', () => {
  const list = subnetCandidates('192.168.1.20');
  assert.equal(list.length, 253);
  assert.ok(!list.includes('192.168.1.20'));
  assert.deepEqual(list.slice(0, 4), ['192.168.1.19', '192.168.1.21', '192.168.1.18', '192.168.1.22']);
  assert.deepEqual(subnetCandidates('not an ip'), []);
});

test('the pairing page is recognised, other pages are not', () => {
  const page = '<title>Companion pairing</title><p>Enter the pairing code shown by RerunTV on the host.</p>';
  assert.equal(looksLikeCompanionBox(200, page), true);
  assert.equal(looksLikeCompanionBox(401, page), true);
  assert.equal(looksLikeCompanionBox(200, '<title>Router login</title>'), false);
  assert.equal(looksLikeCompanionBox(404, page), false);
});

test('a box that still accepts this phone, or has locked pairing, is still a box', () => {
  // A probe that carries an old session cookie gets the companion page itself.
  assert.equal(looksLikeCompanionBox(200, '<!doctype html><title>RerunTV Companion</title>'), true);
  assert.equal(looksLikeCompanionBox(401, '<title>RerunTV Companion</title>'), false);
  assert.equal(looksLikeCompanionBox(423, 'Too many failed pairing attempts. Try again in a few minutes.'), true);
  assert.equal(looksLikeCompanionBox(423, 'Locked'), false);
});

test('the scan sends no cookies', async () => {
  const seen: (RequestCredentials | undefined)[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push(init?.credentials);
    return new Response('<title>Companion pairing</title> RerunTV', { status: 200 });
  }) as unknown as typeof fetch;
  const found = await scanHosts(['192.168.1.9'], { fetchImpl });
  assert.equal(found.length, 1);
  assert.deepEqual(seen, ['omit']);
});

test('subnetBroadcast is the /24 broadcast address', () => {
  assert.equal(subnetBroadcast('192.168.1.20'), '192.168.1.255');
  assert.equal(subnetBroadcast('nope'), null);
});

test('UDP replies: valid, companion off, wrong magic, garbage', () => {
  const ok = JSON.stringify({ magic: DISCOVERY_REPLY_MAGIC, viewerPort: 8080, companionPort: 8725, name: 'LIVINGROOM-PC' });
  assert.deepEqual(parseDiscoveryReply(ok, '192.168.1.9'), { host: '192.168.1.9', port: 8725, name: 'LIVINGROOM-PC', via: 'udp' });
  assert.equal(parseDiscoveryReply(JSON.stringify({ magic: DISCOVERY_REPLY_MAGIC, companionPort: null }), 'x'), null);
  assert.equal(parseDiscoveryReply(JSON.stringify({ magic: 'nope', companionPort: 1 }), 'x'), null);
  assert.equal(parseDiscoveryReply('not json', 'x'), null);
});

test('mergeFound dedupes by host and port and keeps the name', () => {
  const scanned = { host: '1.1.1.1', port: 8725, name: null, via: 'scan' as const };
  const named = { host: '1.1.1.1', port: 8725, name: 'BOX', via: 'udp' as const };
  assert.equal(mergeFound([scanned], named)[0].name, 'BOX');
  assert.equal(mergeFound([named], scanned).length, 1);
  assert.equal(mergeFound([named], { ...scanned, host: '2.2.2.2' }).length, 2);
});

test('scanHosts finds a server that serves the pairing page and ignores the rest', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Companion pairing</title> RerunTV pairing code');
  });
  const other = http.createServer((req, res) => { res.writeHead(200).end('<title>Printer</title>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.2', resolve).on('error', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const progress: number[] = [];
  try {
    const found = await scanHosts(['127.0.0.1', '127.0.0.3'], { port, timeoutMs: 500, onProgress: (done) => progress.push(done) });
    assert.deepEqual(found.map((b) => b.host), ['127.0.0.1']);
    assert.equal(found[0].via, 'scan');
    assert.deepEqual(progress.sort(), [1, 2]);
  } finally {
    server.close();
    other.close();
  }
});

test('scanHosts stops when aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const found = await scanHosts(['127.0.0.1', '127.0.0.2'], { port: 9, signal: controller.signal });
  assert.deepEqual(found, []);
});

test('UDP discovery reports "not available" instead of throwing when the native module is missing', async () => {
  const { udpBroadcast } = await import('../src/lib/discovery.ts');
  assert.equal(await udpBroadcast(() => {}, 50), false);
});
