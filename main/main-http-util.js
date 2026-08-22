// Tiny generic helper shared by the remote/party HTTP servers (main.js) —
// split out on its own since it has no dependency on anything else in this
// app, unlike every other main-*.js module. Also handed to plugins as
// ctx.readJsonBody, so every JSON POST route on every LAN-exposed,
// unauthenticated plugin server (party-channel, universal-remote, ...)
// routes through here.
//
// MAX_JSON_BODY_BYTES caps how much of the body gets buffered before giving
// up — these routes are all short text fields (names, chat-length messages,
// remote commands), never bulk uploads (those go through busboy/multipart
// separately, see party-channel's photo/video intake), so 1MB is already
// generous. Without a cap, any LAN client could send an arbitrarily large
// body and exhaust host memory before JSON.parse ever runs.
const MAX_JSON_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        req.destroy();
        fail(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', fail);
  });
}

module.exports = { readJsonBody, MAX_JSON_BODY_BYTES };
