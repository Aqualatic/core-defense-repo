const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');
const C = require('../shared/config');

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error('Timed out: ' + name)); }, 3000);
    function listener(value) { if (predicate(value)) { clearTimeout(timer); socket.off(name, listener); resolve(value); } }
    socket.on(name, listener);
  });
}
const request = (socket, name, data = {}) => socket.timeout(3000).emitWithAck(name, data);
async function setup(t) {
  let clock = 1000000;
  const app = createServer({ autoTick: false, now: () => clock,
    allowedOrigins: 'http://localhost:3000,https://core-defense.example' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port, clients = [];
  t.after(async () => { clients.forEach(c => c.disconnect()); await app.close(); });
  async function client(origin = 'http://localhost:3000') {
    const c = connect(url, { transports: ['websocket'], extraHeaders: { Origin: origin }, autoConnect: false, reconnection: false });
    clients.push(c); const ready = event(c, 'connect'); c.connect(); await ready; return c;
  }
  function tick(count) { for (let i = 0; i < count; i++) { clock += 1000 / C.network.tickHz; app.tick(); } }
  return { app, url, client, tick, addMs: ms => { clock += ms; } };
}
test('two clients share lobby, countdown, movement and stable authenticated reconnect', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  assert.equal(await (await fetch(f.url + '/health')).text(), 'ok');
  assert.equal((await fetch(f.url + '/shared/config.js')).status, 200);
  const created = await request(a, 'create-room', { nickname: '<b>Sam</b>' });
  assert.match(created.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.notEqual(created.playerId, a.id);
  const both = event(a, 'room-state', s => s.players.length === 2);
  const joined = await request(b, 'join-room', { code: created.code.toLowerCase(), nickname: '<b>Sam</b>' });
  assert.equal(joined.ok, true);
  const lobby = await both;
  assert.equal(lobby.players[0].role, 'Spawner'); assert.equal(lobby.players[1].role, 'Defender');
  assert.equal(lobby.players[1].nickname, '<b>Sam</b #2');
  assert.ok(lobby.players[1].nickname.length <= 12);
  assert.ok(!JSON.stringify(lobby).includes(created.reconnectToken));
  assert.equal((await request(b, 'start-match')).ok, false);
  assert.equal((await request(a, 'start-match')).ok, true);
  assert.equal((await request(a, 'spawn-runner', { gateId: 0 })).ok, false);
  const live = event(b, 'room-state', s => s.game.phase === 'playing'); f.tick(300); await live;
  assert.equal((await request(a, 'spawn-runner', { gateId: 0 })).ok, true);
  const sa = event(a, 'room-state', s => s.game.enemies.length === 1);
  const sb = event(b, 'room-state', s => s.game.enemies.length === 1);
  f.tick(60);
  const [one, two] = await Promise.all([sa, sb]); assert.deepEqual(one, two);
  const offline = event(b, 'room-state', s => s.players.some(p => p.playerId === created.playerId && !p.connected));
  a.disconnect(); const lost = await offline;
  assert.equal(lost.hostId, joined.playerId);
  assert.equal(f.app.rooms.get(created.code).players.size, 2);
  const refreshed = await f.client();
  assert.equal((await request(refreshed, 'resume-room', { ...created, reconnectToken: 'a'.repeat(64) })).ok, false);
  const restoredState = event(b, 'room-state', s => s.players.every(p => p.connected));
  const resumed = await request(refreshed, 'resume-room', created);
  assert.equal(resumed.playerId, created.playerId); assert.notEqual(refreshed.id, a.id);
  assert.equal((await restoredState).players.length, 2);
  assert.equal(f.app.rooms.get(created.code).players.get(created.playerId).role, 'Spawner');
  const hurt = event(b, 'room-state', s => s.game.coreHP === 97); f.tick(94); await hurt;
  const spectator = await f.client();
  const extra = await request(spectator, 'join-room', { code: created.code, nickname: 'Late' });
  assert.equal(f.app.rooms.get(created.code).players.get(extra.playerId).role, 'Spectator');
  assert.equal(f.app.rooms.get(created.code).game.n, 1);
});
test('spawn rate limit counts attempts; reconnect window reserves and then expires', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  const created = await request(a, 'create-room', { nickname: 'A' });
  await request(b, 'join-room', { code: created.code, nickname: 'B' });
  await request(a, 'start-match'); f.tick(300);
  assert.equal((await request(a, 'spawn-runner', { gateId: 0 })).ok, true);
  for (let i = 0; i < 3; i++) assert.match((await request(a, 'spawn-runner', { gateId: 0 })).error, /cooldown/);
  assert.match((await request(a, 'spawn-runner', { gateId: 0 })).error, /rate limit/);
  assert.equal(f.app.rooms.get(created.code).game.money, 130);
  const disconnected = event(b, 'room-state', s => s.players.some(p => !p.connected)); a.disconnect(); await disconnected;
  f.addMs(119999); f.app.cleanup(); assert.equal(f.app.rooms.get(created.code).players.size, 2);
  f.addMs(1); f.app.cleanup(); assert.equal(f.app.rooms.get(created.code).players.size, 1);
  const replacement = await f.client(); assert.equal((await request(replacement, 'resume-room', created)).ok, false);
});
test('snapshot loop emits 15 states in 30 ticks', async t => {
  const f = await setup(t), a = await f.client();
  await request(a, 'create-room', { nickname: 'A' });
  const received = []; a.on('room-state', state => received.push(state));
  const last = event(a, 'room-state', s => s.game.tick === 30);
  f.tick(30); await last;
  assert.equal(received.length, 15);
});

test('allowed cross-origin clients share a room and restore the same player without cookies', async t => {
  const f = await setup(t), a = await f.client('https://core-defense.example'), b = await f.client();
  const created = await request(a, 'create-room', { nickname: 'Phone' });
  await request(b, 'join-room', { nickname: 'Computer', code: created.code });
  await request(a, 'start-match'); f.tick(300);
  await request(a, 'spawn-runner', { gateId: 0 });
  const offline = event(b, 'room-state', s => s.players.some(p => !p.connected));
  a.disconnect(); await offline;
  const reconnected = await f.client('https://core-defense.example');
  const restored = event(reconnected, 'room-state');
  const resumed = await request(reconnected, 'resume-room', created);
  assert.equal(resumed.playerId, created.playerId);
  const s = await restored;
  assert.equal(s.players.length, 2);
  assert.equal(s.players.find(p => p.playerId === resumed.playerId).role, 'Spawner');
  assert.equal(s.game.money, 130);
  assert.equal(s.game.runnerCooldown, 1.5);
});

test('CORS and all Socket.IO handshakes reject unlisted, missing and null origins', async t => {
  const f = await setup(t), endpoint = f.url + '/socket.io/?EIO=4&transport=polling';
  const response = await fetch(endpoint, { method: 'OPTIONS', headers: {
    Origin: 'https://core-defense.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://core-defense.example');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  for (const origin of ['https://other.example', 'https://core-defense.example.evil.test', 'null', undefined]) {
    const headers = origin ? { Origin: origin } : {};
    const denied = await fetch(endpoint, { headers });
    assert.ok(denied.status >= 400);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const socket = connect(f.url, { transports: ['websocket'], extraHeaders: headers,
      autoConnect: false, reconnection: false });
    t.after(() => socket.disconnect());
    const rejected = event(socket, 'connect_error'); socket.connect(); await rejected;
    assert.equal(socket.connected, false);
  }
  assert.equal(await (await fetch(f.url + '/health')).text(), 'ok');
});

test('an existing polling session cannot bypass the origin check on later requests or upgrade', async t => {
  const f = await setup(t), endpoint = f.url + '/socket.io/?EIO=4&transport=polling';
  const handshake = await fetch(endpoint, { headers: { Origin: 'https://core-defense.example' } });
  assert.equal(handshake.headers.get('access-control-allow-origin'), 'https://core-defense.example');
  const sid = JSON.parse((await handshake.text()).slice(1)).sid;
  const denied = await fetch(endpoint + '&sid=' + sid, { headers: { Origin: 'https://other.example' } });
  assert.ok(denied.status >= 400);
  const { WebSocket } = require('ws');
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket&sid=' + sid,
    { origin: 'https://other.example' });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    ws.once('open', () => reject(new Error('Disallowed upgrade was accepted')));
    ws.once('error', resolve);
  });
});
