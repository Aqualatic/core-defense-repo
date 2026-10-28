const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function buildFrontend({ serverUrl, outDir = path.join(root, 'dist') } = {}) {
  let url;
  try { url = new URL(serverUrl); } catch { throw new Error('Set GAME_SERVER_URL to the live Render HTTPS origin before building the Sites frontend.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
    throw new Error('GAME_SERVER_URL must be an HTTPS origin without a path; HTTP is allowed only for localhost testing.');
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'public'), outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(root, 'shared/config.js'), path.join(outDir, 'shared/config.js'));
  fs.writeFileSync(path.join(outDir, 'client-config.js'),
    'window.CoreDefenseClientConfig = Object.freeze(' + JSON.stringify({ serverUrl: url.origin }) + ');\n');
  return outDir;
}

if (require.main === module) {
  console.log('Static frontend ready: ' + buildFrontend({ serverUrl: process.env.GAME_SERVER_URL }));
}
module.exports = { buildFrontend };
