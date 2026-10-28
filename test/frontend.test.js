const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { io } = require('socket.io-client');
const { createServer } = require('../server');
const { allowedOrigins } = require('../server/origins');
const { buildFrontend } = require('../scripts/build-frontend');

test('static frontend serves every asset and connects to a different server origin', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'core-defense-static-test-'));
  const dist = path.join(folder, 'dist');
  const staticApp = express(); staticApp.use(express.static(dist));
  const front = http.createServer(staticApp);
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const frontUrl = 'http://127.0.0.1:' + front.address().port;
  const backend = createServer({ autoTick: false, allowedOrigins: frontUrl });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const backUrl = 'http://127.0.0.1:' + backend.server.address().port;
  let client;
  t.after(async () => {
    client?.disconnect(); await backend.close();
    await new Promise(resolve => front.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  buildFrontend({ serverUrl: backUrl, outDir: dist });
  const html = await (await fetch(frontUrl)).text();
  assert.ok(!html.includes('/socket.io/socket.io.js'));
  const assets = [...html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map(m => m[1]);
  for (const asset of assets) assert.equal((await fetch(frontUrl + asset)).status, 200, asset);
  const scope = { window: {} };
  vm.runInNewContext(await (await fetch(frontUrl + '/client-config.js')).text(), scope);
  assert.equal(scope.window.CoreDefenseClientConfig.serverUrl, backUrl);
  assert.equal(await (await fetch(backUrl + '/health')).text(), 'ok');
  assert.equal((await fetch(backUrl + '/vendor/socket.io.min.js')).status, 200);
  assert.ok((await fetch(backUrl + '/socket.io/socket.io.js')).status >= 400);
  client = io(scope.window.CoreDefenseClientConfig.serverUrl, { transports: ['websocket'],
    extraHeaders: { Origin: frontUrl }, autoConnect: false, reconnection: false, withCredentials: false });
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); client.connect(); });
  const created = await client.timeout(3000).emitWithAck('create-room', { nickname: 'Static client' });
  assert.equal(created.ok, true);
  assert.match(created.reconnectToken, /^[a-f0-9]{64}$/);
});

test('origin lists are exact; unsafe or wildcard entries fail closed', () => {
  const origins = allowedOrigins('https://game.example/, http://localhost:3000');
  assert.ok(origins.has('https://game.example'));
  assert.ok(origins.has('http://localhost:3000'));
  assert.ok(!origins.has('https://game.example.evil.test'));
  for (const value of ['', '*', 'null', 'https://*.example', 'https://game.example/path',
    'http://game.example', 'https://user:pass@game.example', 'https://game.example?room=ABCD']) {
    assert.throws(() => allowedOrigins(value));
  }
});

test('Sites build requires an explicit valid backend and leaves local config unchanged', () => {
  const config = path.join(__dirname, '../public/client-config.js');
  const original = fs.readFileSync(config, 'utf8');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'core-defense-build-test-'));
  try {
    for (const value of [undefined, '', 'http://remote.example', 'https://remote.example/path']) {
      assert.throws(() => buildFrontend({ serverUrl: value, outDir: path.join(folder, 'dist') }));
    }
    buildFrontend({ serverUrl: 'https://server.example', outDir: path.join(folder, 'dist') });
    const scope = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(folder, 'dist/client-config.js'), 'utf8'), scope);
    assert.equal(scope.window.CoreDefenseClientConfig.serverUrl, 'https://server.example');
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    const local = { window: {} }; vm.runInNewContext(original, local);
    assert.equal(local.window.CoreDefenseClientConfig.serverUrl, '');
    assert.ok(fs.existsSync(path.join(folder, 'dist/vendor/socket.io.LICENSE')));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
