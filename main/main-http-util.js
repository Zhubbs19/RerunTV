// Tiny generic helper shared by the remote/party HTTP servers (main.js) —
// split out on its own since it has no dependency on anything else in this
// app, unlike every other main-*.js module.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { readJsonBody };
