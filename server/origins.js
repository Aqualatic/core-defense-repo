const C = require('../shared/config');

function allowedOrigins(value = process.env.ALLOWED_ORIGINS) {
  if (value === undefined) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set ALLOWED_ORIGINS to a comma-separated list of exact frontend origins.');
    const port = process.env.PORT || C.server.defaultPort;
    value = 'http://localhost:' + port + ',http://127.0.0.1:' + port;
  }
  const entries = value.split(',').map(s => s.trim()).filter(Boolean);
  if (!entries.length) throw new Error('ALLOWED_ORIGINS must not be empty.');
  return new Set(entries.map(entry => {
    let url;
    try { url = new URL(entry); } catch { throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
      throw new Error('ALLOWED_ORIGINS requires HTTPS origins (HTTP is allowed for localhost), without paths or wildcards.');
    }
    return url.origin;
  }));
}

module.exports = { allowedOrigins };
