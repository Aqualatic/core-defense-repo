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
  const logs = [];
  const app = createServer({ autoTick: false, now: () => clock, logMatch: entry => logs.push(entry),
    allowedOrigins: 'http://localhost:3000,https://core-defense.example' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port, clients = [];
  t.after(async () => { clients.forEach(c => c.disconnect()); await app.close(); });
  async function client(origin = 'http://localhost:3000') {
    const c = connect(url, { transports: ['websocket'], extraHeaders: { Origin: origin }, autoConnect: false, reconnection: false });
    clients.push(c); const ready = event(c, 'connect'); c.connect(); await ready; return c;
  }
  function tick(count) { for (let i = 0; i < count; i++) { clock += 1000 / C.network.tickHz; app.tick(); } }
  return { app, url, client, tick, logs, addMs: ms => { clock += ms; } };
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

test('simultaneous Defenders purchase one slot once; towers fight while their owner reconnects', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client(), c = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const sam = await request(b, 'join-room', { code: host.code, nickname: 'Sam' });
  const lee = await request(c, 'join-room', { code: host.code, nickname: 'Lee' });
  await request(a, 'start-match');
  assert.match((await request(b, 'place-tower', { snapId: 12 })).error, /begin/);
  f.tick(300);
  assert.match((await request(a, 'place-tower', { snapId: 12 })).error, /Only/);
  const results = await Promise.all([request(b, 'place-tower', { snapId: 12, ownerId: host.playerId, cost: 0 }),
    request(c, 'place-tower', { snapId: 12 })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.match(results.find(r => !r.ok).error, /occupied/);
  const owner = results[0].ok ? sam : lee, ownerSocket = results[0].ok ? b : c;
  const sa = event(a, 'room-state', s => s.game.towers.length === 1);
  const sb = event(b, 'room-state', s => s.game.towers.length === 1);
  f.tick(2);
  const [one, two] = await Promise.all([sa, sb]); assert.deepEqual(one, two);
  assert.ok(Math.abs(one.game.treasury - (110 + 2 / 30 * 5)) < 1e-8);
  assert.equal(one.game.towers[0].ownerId, owner.playerId);
  assert.equal(one.game.spendFeed.length, 1);
  await request(a, 'spawn-runner', { gateId: 0 });
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected));
  ownerSocket.disconnect(); await offline;
  const kill = event(a, 'room-state', s => s.game.towers[0].kills === 1);
  f.tick(86);
  const fought = await kill;
  assert.equal(fought.game.coreHP, 100); assert.equal(fought.game.enemies.length, 0);
  assert.equal(fought.game.towers[0].damageDealt, 20);
  const refreshed = await f.client(), restored = event(refreshed, 'room-state');
  assert.equal((await request(refreshed, 'resume-room', owner)).playerId, owner.playerId);
  const s = await restored;
  assert.equal(s.players.length, 3); assert.equal(s.game.towers[0].ownerId, owner.playerId);
  assert.equal(s.game.towers[0].kills, 1); assert.equal(s.game.spendFeed.length, 1);
  assert.ok(Math.abs(s.game.treasury - (110 + 88 / 30 * 5 + 6)) < 1e-8);
  assert.match((await request(refreshed, 'place-tower', { snapId: 12 })).error, /occupied/);
});

test('placement validates shared funds and counts rejected attempts across reconnect', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const defender = await request(b, 'join-room', { code: host.code, nickname: 'Build' });
  await request(a, 'start-match'); f.tick(300);
  for (const snapId of [0, 4, 12]) assert.equal((await request(b, 'place-tower', { snapId })).ok, true);
  assert.match((await request(b, 'place-tower', { snapId: 8 })).error, /Treasury/);
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected));
  b.disconnect(); await offline;
  const refreshed = await f.client(); await request(refreshed, 'resume-room', defender);
  assert.match((await request(refreshed, 'place-tower', { snapId: 8 })).error, /rate limit/);
  const g = f.app.rooms.get(host.code).game;
  assert.equal(g.towers.length, 3); assert.equal(g.spendFeed.length, 3); assert.equal(g.treasury, 0);
  const spectator = await f.client(); await request(spectator, 'join-room', { code: host.code, nickname: 'Late' });
  assert.match((await request(spectator, 'place-tower', { snapId: 8 })).error, /Only/);
});

test('two Defenders share bounty but keep separate damage/assist scores, ownership and selling after refresh', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client(), c = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const sam = await request(b, 'join-room', { code: host.code, nickname: 'Sam' });
  const lee = await request(c, 'join-room', { code: host.code, nickname: 'Lee' });
  await request(a, 'start-match'); f.tick(300);
  assert.equal((await request(b, 'place-tower', { type: 'Freezer', snapId: 12 })).ok, true);
  assert.equal((await request(c, 'place-tower', { type: 'Shooter', snapId: 11 })).ok, true);
  const g = f.app.rooms.get(host.code).game, freezerId = g.towers[0].id;
  assert.match((await request(b, 'sell-tower', { towerId: freezerId })).error, /locked/);
  assert.match((await request(c, 'sell-tower', { towerId: freezerId, ownerId: sam.playerId })).error, /owner/);
  assert.match((await request(a, 'sell-tower', { towerId: freezerId })).error, /Only/);
  await request(a, 'spawn-runner', { gateId: 0 });
  const scoredA = event(a, 'room-state', s => s.game.scores.some(p => p.kills === 1));
  const scoredC = event(c, 'room-state', s => s.game.scores.some(p => p.kills === 1));
  f.tick(140);
  const [first, second] = await Promise.all([scoredA, scoredC]); assert.deepEqual(first, second);
  assert.equal(first.game.coreHP, 100);
  const samScore = first.game.scores.find(s => s.playerId === sam.playerId);
  const leeScore = first.game.scores.find(s => s.playerId === lee.playerId);
  assert.equal(samScore.points, 2); assert.equal(samScore.damage, 0);
  assert.equal(leeScore.points, 25); assert.equal(leeScore.damage, 20); assert.equal(leeScore.kills, 1);
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected)); b.disconnect(); await offline;
  assert.match((await request(c, 'sell-tower', { towerId: freezerId })).error, /owner/);
  const refreshed = await f.client(), restored = event(refreshed, 'room-state');
  await request(refreshed, 'resume-room', sam);
  assert.equal((await restored).game.scores.find(s => s.playerId === sam.playerId).points, 2);
  const before = g.treasury;
  const sold = await Promise.all([request(refreshed, 'sell-tower', { towerId: freezerId }), request(refreshed, 'sell-tower', { towerId: freezerId })]);
  assert.equal(sold.filter(r => r.ok).length, 1); assert.equal(g.treasury, before + 45);
  assert.equal(g.scores.find(s => s.playerId === sam.playerId).points, 2);
  f.tick(330);
  assert.equal((await request(refreshed, 'place-tower', { type: 'Cannon', snapId: 12 })).ok, true);
  assert.equal(g.towers.at(-1).ownerId, sam.playerId);
});

test('sell rate limits count rejected requests and survive reconnect without changing the treasury', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const defender = await request(b, 'join-room', { code: host.code, nickname: 'Build' });
  await request(a, 'start-match'); f.tick(300);
  await request(b, 'place-tower', { type: 'Cannon', snapId: 12 });
  for (let i = 0; i < 4; i++) assert.match((await request(b, 'sell-tower', { towerId: -1 })).error, /not found/);
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected)); b.disconnect(); await offline;
  const refreshed = await f.client(); await request(refreshed, 'resume-room', defender);
  const g = f.app.rooms.get(host.code).game, id = g.towers[0].id;
  assert.match((await request(refreshed, 'sell-tower', { towerId: id })).error, /rate limit/);
  assert.equal(g.treasury, 30); assert.equal(g.towers.length, 1);
  f.tick(31); const before = g.treasury;
  assert.equal((await request(refreshed, 'sell-tower', { towerId: id })).ok, true);
  assert.equal(g.treasury, before + 60);
});

test('typed spawns share an attempt limit, reserve Swarm slots and keep warnings/cooldowns through refresh', async t => {
  const f = await setup(t), a = await f.client('https://core-defense.example'), b = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  await request(b, 'join-room', { code: host.code, nickname: 'Build' });
  await request(a, 'start-match'); f.tick(300);
  assert.equal((await request(a, 'spawn-enemy', { type: 'Swarm', gateId: 0 })).ok, true);
  assert.equal((await request(a, 'spawn-enemy', { type: 'Tank', gateId: 2 })).ok, true);
  assert.match((await request(a, 'spawn-enemy', { type: 'Swarm', gateId: 3 })).error, /cooldown/);
  assert.match((await request(a, 'spawn-runner', { gateId: 1 })).error, /money/);
  const offline = event(b, 'room-state', s => s.players.some(p => !p.connected)); a.disconnect(); await offline;
  const refreshed = await f.client('https://core-defense.example'), restored = event(refreshed, 'room-state');
  await request(refreshed, 'resume-room', host);
  const s = await restored;
  assert.equal(s.game.money, 10); assert.equal(s.game.enemySlots.pending, 6);
  assert.deepEqual(s.game.warnings.map(w => w.type), ['Swarm', 'Tank']);
  assert.equal(s.game.spawns.Swarm.cooldown, 6); assert.equal(s.game.spawns.Tank.cooldown, 8);
  assert.match((await request(refreshed, 'spawn-enemy', { type: 'Runner', gateId: 0 })).error, /rate limit/);
  assert.match((await request(b, 'spawn-enemy', { type: 'Tank', gateId: 0 })).error, /Only/);
  const first = event(b, 'room-state', s => s.game.enemies.length === 2);
  f.tick(60); const live = await first;
  assert.deepEqual(live.game.enemies.map(e => [e.type, e.hp]), [['Swarm', 100], ['Tank', 300]]);
  assert.equal(live.game.enemySlots.used, 6);
  const split = event(b, 'room-state', s => s.game.enemies.filter(e => e.type === 'Tiny').length === 5);
  f.tick(104); const children = await split;
  assert.equal(children.game.enemySlots.used, 6); assert.equal(children.game.coreHP, 100);
  assert.equal(children.game.scores.find(p => p.role === 'Defender').kills, 0);
});

test('simultaneous Core Repairs charge once, credit the actor and persist shared cooldown across refresh', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client(), c = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const sam = await request(b, 'join-room', { code: host.code, nickname: 'Sam' });
  const lee = await request(c, 'join-room', { code: host.code, nickname: 'Lee' });
  await request(a, 'start-match');
  assert.match((await request(b, 'repair-core')).error, /begin/); f.tick(300);
  assert.match((await request(b, 'repair-core')).error, /full/);
  assert.match((await request(a, 'repair-core')).error, /Only/);
  // Exact low-HP fixture isolates the shared transaction without a full damage battle.
  const g = f.app.rooms.get(host.code).game; g.coreHP = 90;
  const before = g.treasury;
  const results = await Promise.all([request(b, 'repair-core', { heal: 100, cost: 0 }), request(c, 'repair-core')]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.match(results.find(r => !r.ok).error, /cooldown/);
  assert.equal(g.coreHP, 95); assert.equal(g.treasury, before - 60);
  const winner = results[0].ok ? sam : lee;
  assert.equal(g.scores.find(p => p.playerId === winner.playerId).points, 10);
  assert.equal(g.spendFeed.filter(e => e.action === 'repaired').length, 1);
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected)); b.disconnect(); await offline;
  const refreshed = await f.client(), restored = event(refreshed, 'room-state');
  await request(refreshed, 'resume-room', sam); assert.equal((await restored).game.repairCooldown, 20);
  assert.match((await request(refreshed, 'repair-core')).error, /cooldown/);
  assert.match((await request(refreshed, 'repair-core')).error, /cooldown/);
  assert.match((await request(refreshed, 'repair-core')).error, /rate limit/);
  f.tick(599); assert.match((await request(c, 'repair-core')).error, /cooldown/);
  f.tick(1); assert.equal((await request(c, 'repair-core')).ok, true); assert.equal(g.coreHP, 100);
  const paid = g.treasury; assert.match((await request(c, 'repair-core')).error, /full/);
  assert.equal(g.treasury, paid);
});

test('each completed match logs cooldown seconds once and awards only the winning participants', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client(), c = await f.client();
  const host = await request(a, 'create-room', { nickname: 'Attack' });
  const sam = await request(b, 'join-room', { code: host.code, nickname: 'Sam' });
  await request(a, 'start-match'); f.tick(300);
  const late = await request(c, 'join-room', { code: host.code, nickname: 'Late' });
  const g = f.app.rooms.get(host.code).game; g.money = 40;
  await request(a, 'spawn-enemy', { type: 'Runner', gateId: 0 }); f.tick(45);
  g.matchTick = C.match.durationSeconds * C.network.tickHz - 1; f.tick(1);
  assert.equal(f.logs.length, 1);
  const { economy, ...cooldownRecord } = f.logs[0];
  assert.deepEqual(cooldownRecord, { event: 'spawner-cooldown-summary', room: host.code, endedBy: 'match-finished',
    winner: 'Defender', defenders: 1, elapsedSeconds: 300,
    perTypeSeconds: { Runner: 1.5, Tank: 0, Swarm: 0 }, anyTypeSeconds: 1.5, allAffordableSeconds: 1.5 });
  assert.deepEqual(economy.settings, { upkeepSlope: 0, coreHitReward: 5 });
  assert.equal(economy.samples[0].seconds, 0); assert.equal(economy.samples.at(-1).seconds, 300);
  assert.equal(economy.spawner.totalSpent, 20);
  assert.ok(Math.abs(economy.defenders.finalBalance - g.treasury) < 1e-7);
  assert.equal(g.scores.find(p => p.playerId === sam.playerId).winBonus, 100);
  assert.equal(g.scores.find(p => p.playerId === host.playerId).winBonus, 0);
  assert.equal(g.scores.some(p => p.playerId === late.playerId), false);
  f.tick(30); assert.equal(f.logs.length, 1);
  const offline = event(a, 'room-state', s => s.players.some(p => !p.connected)); b.disconnect(); await offline;
  const refreshed = await f.client(), restored = event(refreshed, 'room-state');
  await request(refreshed, 'resume-room', sam);
  assert.equal((await restored).game.scores.find(p => p.playerId === sam.playerId).winBonus, 100);
  assert.equal(f.logs.length, 1);
});
