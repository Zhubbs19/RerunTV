// Minimal mDNS (RFC 6762) client for discovering Chromecast/Google TV
// devices on the LAN — hand-rolled for the same reason castv2-lite.js is:
// no first-party plugin in this repo bundles third-party npm packages, and
// the slice of DNS message format actually needed (a PTR query, PTR/SRV/A/TXT
// answers, name-pointer decompression) is small enough to encode/decode by
// hand.
'use strict';

const dgram = require('dgram');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_googlecast._tcp.local';

function encodeName(name) {
  const labels = name.replace(/\.$/, '').split('.');
  const parts = labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'utf8')]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

// Decodes a DNS name starting at `offset`, following RFC 1035 pointer
// compression (a 0xC0-prefixed 2-byte offset back into the packet).
// Returns { name, next } where `next` is the offset just past this name in
// the ORIGINAL (unfollowed) position — i.e. where the caller should resume
// reading the rest of the record.
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let sawPointer = false;
  let afterFirstPointer = -1;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[pos];
    if (len === 0) { pos += 1; if (!sawPointer) afterFirstPointer = pos; break; }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!sawPointer) afterFirstPointer = pos + 2;
      sawPointer = true;
      pos = pointer;
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: afterFirstPointer };
}

function buildPtrQuery() {
  const header = Buffer.alloc(12); // id=0, flags=0 (standard query), qdcount=1
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([
    encodeName(SERVICE),
    Buffer.from([0x00, 0x0c]), // QTYPE = PTR
    Buffer.from([0x00, 0x01]), // QCLASS = IN
  ]);
  return Buffer.concat([header, question]);
}

// Parses one mDNS response packet, folding any PTR/SRV/A/TXT records it
// contains into `state` (mutated in place — a device's SRV/A/TXT records
// routinely arrive in separate packets, not all in one).
function parseResponse(buf, state) {
  if (buf.length < 12) return;
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);
  let offset = 12;
  // Skip the question section, if any.
  const qdcount = buf.readUInt16BE(4);
  for (let i = 0; i < qdcount; i++) {
    const { next } = decodeName(buf, offset);
    offset = next + 4; // QTYPE + QCLASS
  }
  const totalRecords = ancount + nscount + arcount;
  for (let i = 0; i < totalRecords; i++) {
    if (offset >= buf.length) return;
    const nameRes = decodeName(buf, offset);
    offset = nameRes.next;
    if (offset + 10 > buf.length) return;
    const type = buf.readUInt16BE(offset);
    const rdlength = buf.readUInt16BE(offset + 8);
    const rdataStart = offset + 10;
    const rdataEnd = rdataStart + rdlength;
    if (rdataEnd > buf.length) return;

    if (type === 12) { // PTR
      const { name: target } = decodeName(buf, rdataStart);
      state.instances[target] = state.instances[target] || {};
    } else if (type === 33 && nameRes.name.endsWith(SERVICE)) { // SRV
      const port = buf.readUInt16BE(rdataStart + 4);
      const { name: target } = decodeName(buf, rdataStart + 6);
      state.instances[nameRes.name] = { ...(state.instances[nameRes.name] || {}), port, target };
    } else if (type === 1) { // A
      const ip = `${buf[rdataStart]}.${buf[rdataStart + 1]}.${buf[rdataStart + 2]}.${buf[rdataStart + 3]}`;
      state.addresses[nameRes.name] = ip;
    } else if (type === 16 && nameRes.name.endsWith(SERVICE)) { // TXT
      let p = rdataStart;
      const txt = {};
      while (p < rdataEnd) {
        const len = buf[p];
        const entry = buf.toString('utf8', p + 1, p + 1 + len);
        const eq = entry.indexOf('=');
        if (eq >= 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
        p += 1 + len;
      }
      state.txt[nameRes.name] = txt;
    }

    offset = rdataEnd;
  }
}

function buildDeviceList(state) {
  const devices = [];
  for (const [instanceName, info] of Object.entries(state.instances)) {
    if (!info.target || !info.port) continue;
    const ip = state.addresses[info.target];
    if (!ip) continue;
    const txt = state.txt[instanceName] || {};
    const label = txt.fn || instanceName.replace(new RegExp(`\\.${SERVICE}$`), '');
    devices.push({ name: label, host: ip, port: info.port });
  }
  return devices;
}

// Broadcasts a PTR query for _googlecast._tcp.local and collects responses
// for `timeoutMs`, resolving with whatever devices were assembled from
// PTR+SRV+A(+TXT) records seen in that window. Devices already on the
// network typically respond within a few hundred ms of the query, so the
// default window is generous mainly for a device that's mid-boot.
function discoverCastDevices({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const state = { instances: {}, addresses: {}, txt: {} };
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch (e) {}
      resolve(buildDeviceList(state));
    }

    socket.on('error', finish);
    socket.on('message', (msg) => {
      try { parseResponse(msg, state); } catch (e) { /* one malformed packet shouldn't abort the scan */ }
    });
    socket.bind(0, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        const query = buildPtrQuery();
        socket.send(query, MDNS_PORT, MDNS_ADDRESS);
      } catch (e) { finish(); return; }
      setTimeout(finish, timeoutMs);
    });
  });
}

module.exports = { discoverCastDevices };
