// Minimal Google Cast v2 (CASTV2) sender, hand-rolled instead of pulling in
// castv2-client/protobufjs as npm dependencies — no first-party plugin in
// this repo bundles third-party npm packages (see PLUGIN_DEVELOPMENT.md),
// and the wire format actually needed here (CastMessage: a handful of
// string/varint fields, JSON payloads) is small enough to encode/decode by
// hand. Only the fields this plugin actually reads/writes are handled; an
// unknown field on a decoded message is skipped, not an error.
'use strict';

const tls = require('tls');
const net = require('net');

/**
 * Cast receivers present self-signed certificates, so certificate validation has to be off for
 * them. To keep that from ever applying to an arbitrary host, only LAN addresses (private,
 * loopback and link-local ranges, or a .local name) are accepted.
 * @param {string} host A host name or IP address, optionally in brackets.
 * @returns {boolean} Whether the host is a LAN address or a .local name.
 */
function isLanAddress(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(h)) {
    const l = h.toLowerCase();
    return l === '::1' || /^f[cd][0-9a-f]{2}:/.test(l) || /^fe[89ab][0-9a-f]:/.test(l);
  }
  return /^[a-z0-9-]+\.local$/i.test(h);
}

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';
const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';
const SENDER_ID = 'sender-0';
const PLATFORM_DESTINATION = 'receiver-0';

// ---- protobuf wire-format helpers (CastMessage only) ----
// message CastMessage {
//   1 required int32 protocol_version;
//   2 required string source_id;
//   3 required string destination_id;
//   4 required string namespace;
//   5 required enum payload_type;   // 0 = STRING
//   6 optional string payload_utf8;
// }

/**
 * Encodes a non-negative integer as a protobuf varint.
 * @param {number} n The value.
 * @returns {Buffer} The varint bytes.
 */
function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Encodes a protobuf field tag.
 * @param {number} fieldNum The field number.
 * @param {number} wireType The wire type (0 varint, 2 length-delimited).
 * @returns {Buffer} The tag bytes.
 */
function encodeTag(fieldNum, wireType) {
  return encodeVarint((fieldNum << 3) | wireType);
}

/**
 * Encodes a length-delimited UTF-8 string field.
 * @param {number} fieldNum The field number.
 * @param {string} str The value.
 * @returns {Buffer} The encoded field.
 */
function encodeStringField(fieldNum, str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(strBuf.length), strBuf]);
}

/**
 * Encodes a varint field.
 * @param {number} fieldNum The field number.
 * @param {number} value The value.
 * @returns {Buffer} The encoded field.
 */
function encodeVarintField(fieldNum, value) {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(value)]);
}

/**
 * Encodes one CastMessage with a string payload, prefixed with its 4-byte big-endian length.
 * @param {object} msg The message.
 * @param {string} msg.sourceId The sender id.
 * @param {string} msg.destinationId The receiver or transport id.
 * @param {string} msg.namespace The Cast namespace URN.
 * @param {string|object} msg.data The payload; objects are sent as JSON.
 * @returns {Buffer} The framed message.
 */
function encodeCastMessage({ sourceId, destinationId, namespace, data }) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const body = Buffer.concat([
    encodeVarintField(1, 0), // protocol_version = CASTV2_1_0
    encodeStringField(2, sourceId),
    encodeStringField(3, destinationId),
    encodeStringField(4, namespace),
    encodeVarintField(5, 0), // payload_type = STRING
    encodeStringField(6, payload),
  ]);
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([lenPrefix, body]);
}

/**
 * Reads a varint from `buf` at `offset`.
 * @param {Buffer} buf The message bytes.
 * @param {number} offset Where the varint starts.
 * @returns {object} `{ value, offset }`, with `offset` just past the varint.
 */
function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, offset: pos };
}

/**
 * Decodes just the fields this plugin cares about (namespace + payload_utf8);
 * any other field tag is skipped by its wire type.
 * @param {Buffer} body One message body, without its length prefix.
 * @returns {object} `{ namespace, payloadUtf8 }`, either null when absent.
 */
function decodeCastMessage(body) {
  const out = { namespace: null, payloadUtf8: null };
  let offset = 0;
  while (offset < body.length) {
    const tagRead = readVarint(body, offset);
    offset = tagRead.offset;
    const fieldNum = tagRead.value >> 3;
    const wireType = tagRead.value & 0x7;
    if (wireType === 0) {
      const v = readVarint(body, offset);
      offset = v.offset;
    } else if (wireType === 2) {
      const lenRead = readVarint(body, offset);
      offset = lenRead.offset;
      const str = body.toString('utf8', offset, offset + lenRead.value);
      offset += lenRead.value;
      if (fieldNum === 4) out.namespace = str;
      if (fieldNum === 6) out.payloadUtf8 = str;
    } else {
      break; // unsupported wire type for anything this plugin reads — stop rather than misparse
    }
  }
  return out;
}

/**
 * Splits a stream of concatenated length-prefixed messages, handling partial
 * TCP chunks the same way any other length-prefixed protocol has to.
 */
class MessageFramer {
  /**
   * Creates a framer that calls `onMessage` for each complete decoded message.
   * @param {Function} onMessage Receives each decoded `{ namespace, payloadUtf8 }`.
   */
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }
  /**
   * Appends a TCP chunk and emits every complete message now buffered.
   * @param {Buffer} chunk Bytes read from the socket.
   */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) return;
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try { this.onMessage(decodeCastMessage(body)); } catch (e) { /* one malformed frame shouldn't kill the connection */ }
    }
  }
}

/**
 * A small sender-side session: connects, launches the default media
 * receiver, and exposes load/play/pause/seek/stop/setVolume plus a status
 * callback. One instance per connected device.
 */
class CastSession {
  /**
   * Creates an unconnected session for one Cast device.
   * @param {object} opts Session options.
   * @param {string} opts.host The device address; must be on the LAN.
   * @param {number} [opts.port=8009] The Cast port.
   * @param {Function} [opts.onStatus] Receives `{ state, ... }` status updates.
   */
  constructor({ host, port, onStatus }) {
    this.host = host;
    this.port = port || 8009;
    this.onStatus = onStatus || (() => {});
    this.socket = null;
    this.framer = new MessageFramer((msg) => this._handleMessage(msg));
    this.requestId = 1;
    this.transportId = null;
    this.receiverSessionId = null;
    this.mediaSessionId = null;
    this.heartbeatTimer = null;
    this.connected = false;
    this.pendingLaunch = null;
  }

  /**
   * Opens the TLS connection, starts the heartbeat and launches the default media receiver.
   * @returns {Promise<void>} Resolves once the receiver app's transport is connected.
   * @throws {Error} When the host is not a LAN address, the connection fails or either step times out (as a rejection).
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (!isLanAddress(this.host)) {
        reject(new Error('Cast receivers must be on the local network; refusing to connect to ' + this.host));
        return;
      }
      // rejectUnauthorized is false only because Cast receivers use self-signed certificates
      // (see isLanAddress above, which limits this to LAN hosts).
      const socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => {
        this.connected = true;
        this._send(NS_CONNECTION, PLATFORM_DESTINATION, { type: 'CONNECT' });
        this.heartbeatTimer = setInterval(() => {
          this._send(NS_HEARTBEAT, PLATFORM_DESTINATION, { type: 'PING' });
        }, 5000);
        this._launchDefaultReceiver().then(resolve, reject);
      });
      socket.on('data', (chunk) => this.framer.push(chunk));
      socket.on('error', (err) => { this.connected = false; reject(err); this.onStatus({ state: 'error', error: err.message }); });
      socket.on('close', () => { this.connected = false; this.onStatus({ state: 'disconnected' }); });
      this.socket = socket;
      // A device that's off/unreachable never fires the TLS callback — give
      // up rather than hanging the caller's await forever.
      setTimeout(() => { if (!this.connected) reject(new Error('Timed out connecting to cast device')); }, 8000);
    });
  }

  /**
   * Closes the receiver transport and the device connection and stops the heartbeat.
   */
  disconnect() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.transportId) { try { this._send(NS_CONNECTION, this.transportId, { type: 'CLOSE' }); } catch (e) {} }
    if (this.socket) { try { this._send(NS_CONNECTION, PLATFORM_DESTINATION, { type: 'CLOSE' }); } catch (e) {} this.socket.destroy(); }
    this.socket = null;
    this.connected = false;
    this.transportId = null;
    this.receiverSessionId = null;
  }

  /**
   * Sends one JSON message on `namespace` to `destinationId`; a no-op when not connected.
   * @param {string} namespace The Cast namespace URN.
   * @param {string} destinationId The receiver or transport id.
   * @param {object} data The payload.
   */
  _send(namespace, destinationId, data) {
    if (!this.socket) return;
    this.socket.write(encodeCastMessage({ sourceId: SENDER_ID, destinationId, namespace, data }));
  }

  /**
   * Asks the device to launch the Default Media Receiver app.
   * @returns {Promise<void>} Resolves when its transport appears in a RECEIVER_STATUS, or rejects after 8 s.
   */
  _launchDefaultReceiver() {
    return new Promise((resolve, reject) => {
      this.pendingLaunch = { resolve, reject };
      this._send(NS_RECEIVER, PLATFORM_DESTINATION, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER_APP_ID, requestId: this.requestId++ });
      setTimeout(() => {
        if (this.pendingLaunch) { this.pendingLaunch = null; reject(new Error('Timed out launching the default media receiver')); }
      }, 8000);
    });
  }

  /**
   * Handles one decoded message: answers heartbeats, tracks the receiver transport and media session, and reports status.
   * @param {object} msg A decoded `{ namespace, payloadUtf8 }`.
   */
  _handleMessage(msg) {
    if (!msg.namespace || !msg.payloadUtf8) return;
    let data;
    try { data = JSON.parse(msg.payloadUtf8); } catch (e) { return; }

    if (msg.namespace === NS_HEARTBEAT && data.type === 'PING') {
      this._send(NS_HEARTBEAT, PLATFORM_DESTINATION, { type: 'PONG' });
      return;
    }
    if (msg.namespace === NS_RECEIVER && data.type === 'RECEIVER_STATUS') {
      const apps = (data.status && data.status.applications) || [];
      const app = apps.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER_APP_ID);
      if (app) this.receiverSessionId = app.sessionId || null;
      if (app && app.transportId && app.transportId !== this.transportId) {
        this.transportId = app.transportId;
        this._send(NS_CONNECTION, this.transportId, { type: 'CONNECT' });
        if (this.pendingLaunch) { this.pendingLaunch.resolve(); this.pendingLaunch = null; }
      }
      const volume = data.status && data.status.volume;
      this.onStatus({ state: 'connected', volume });
      return;
    }
    if (msg.namespace === NS_MEDIA && (data.type === 'MEDIA_STATUS')) {
      const status = (data.status && data.status[0]) || null;
      if (status) {
        this.mediaSessionId = status.mediaSessionId;
        this.onStatus({
          state: 'media',
          playerState: status.playerState,
          currentTime: status.currentTime,
          media: status.media,
        });
      }
      return;
    }
  }

  /**
   * Asks the receiver to load and autoplay a media URL.
   * @param {object} media What to load.
   * @param {string} media.url The media URL the device fetches.
   * @param {string} [media.contentType='video/mp4'] The MIME type.
   * @param {number} [media.currentTimeSec=0] Start position in seconds.
   * @param {string} [media.title] Title shown on the TV.
   * @param {string} [media.streamType='BUFFERED'] `BUFFERED` or `LIVE`.
   * @throws {Error} When no receiver app is connected yet.
   */
  loadMedia({ url, contentType, currentTimeSec, title, streamType = 'BUFFERED' }) {
    if (!this.transportId) throw new Error('Not connected to a receiver app yet');
    this._send(NS_MEDIA, this.transportId, {
      type: 'LOAD',
      requestId: this.requestId++,
      // The receiver application session and its message transport are
      // different Cast identifiers. Using transportId here makes the
      // Default Media Receiver reject otherwise valid LOAD requests.
      sessionId: this.receiverSessionId || undefined,
      media: {
        contentId: url,
        contentType: contentType || 'video/mp4',
        streamType,
        metadata: title ? { metadataType: 0, title } : undefined,
      },
      currentTime: currentTimeSec || 0,
      autoplay: true,
    });
  }

  /**
   * Seeks the current media; a no-op without a media session.
   * @param {number} currentTimeSec The position in seconds.
   */
  seek(currentTimeSec) {
    if (!this.transportId || !this.mediaSessionId) return;
    this._send(NS_MEDIA, this.transportId, { type: 'SEEK', requestId: this.requestId++, mediaSessionId: this.mediaSessionId, currentTime: currentTimeSec });
  }

  /**
   * Stops the current media; a no-op without a media session.
   */
  stopMedia() {
    if (!this.transportId || !this.mediaSessionId) return;
    this._send(NS_MEDIA, this.transportId, { type: 'STOP', requestId: this.requestId++, mediaSessionId: this.mediaSessionId });
  }

  /**
   * Sets the device volume.
   * @param {number} level Volume from 0 to 1; clamped.
   */
  setVolume(level) {
    this._send(NS_RECEIVER, PLATFORM_DESTINATION, { type: 'SET_VOLUME', requestId: this.requestId++, volume: { level: Math.max(0, Math.min(1, level)) } });
  }
}

module.exports = { CastSession, isLanAddress };
