// ---------- LAN viewer auto-discovery (UDP) ----------
// A tiny custom broadcast/reply protocol (Node's built-in dgram, no new
// dependency) so neither the Android TV client (android-tv-client/) nor the
// Android companion remote (android-remote-client/) require typing in this
// machine's IP address by hand. A client broadcasts DISCOVERY_MAGIC to
// DISCOVERY_PORT on the LAN; this listens on that same port and replies
// directly (unicast, to the sender's own address) with this machine's
// viewer and remote-control ports — the client already knows the sender's
// IP from the UDP packet's own source address, so the reply only needs to
// carry the ports. Deliberately not real mDNS/Bonjour: that would need a new
// dependency on both the Node and Android sides for a single-purpose LAN
// tool that only ever has one kind of thing to discover.
const os = require('os');
const { VIEWER_PORT, REMOTE_PORT } = require('./main-lan');

const DISCOVERY_PORT = 41234;
const DISCOVERY_MAGIC = 'RETRO_CABLE_BOX_DISCOVER';
const DISCOVERY_REPLY_MAGIC = 'RETRO_CABLE_BOX_HELLO';

function startDiscoveryServer() {
  const dgram = require('dgram');
  const socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    console.error(`Discovery server failed on port ${DISCOVERY_PORT}:`, err.message);
  });

  socket.on('message', (msg, rinfo) => {
    if (msg.toString('utf-8') !== DISCOVERY_MAGIC) return;
    const reply = Buffer.from(JSON.stringify({
      magic: DISCOVERY_REPLY_MAGIC,
      viewerPort: VIEWER_PORT,
      remotePort: REMOTE_PORT,
      name: os.hostname(),
    }));
    socket.send(reply, rinfo.port, rinfo.address);
  });

  socket.bind(DISCOVERY_PORT, '0.0.0.0');
}

module.exports = { startDiscoveryServer };
