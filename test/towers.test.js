const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const G = require('../server/game');
const defender = { playerId: 'defender', nickname: 'Sam', role: 'Defender', connected: true };
const spawner = { playerId: 'spawner', nickname: 'Alex', role: 'Spawner', connected: true };
function advance(g, count) { for (let i = 0; i < count; i++) G.step(g); }
function playing(n = 1) {
  const g = G.newGame();
  G.start(g, [spawner, ...Array.from({ length: n }, () => ({ ...defender }))]);
  advance(g, 300); return g;
}
const runner = (id, x, y) => ({ id, x, y, type: 'Runner', hp: 20 });

test('shared treasury starts from fixed N, earns 5/sec only during play and freezes at the end', () => {
  for (const n of [1, 3, 7]) {
    const g = playing(n);
    assert.equal(g.treasury, 150 + (n - 1) * 10);
    advance(g, 30);
    assert.ok(Math.abs(g.treasury - (150 + (n - 1) * 10 + 5)) < 1e-8);
    g.matchTick = 8999; G.step(g);
    const money = g.treasury; advance(g, 30); assert.equal(g.treasury, money);
  }
});

test('Shooter placement validates role, phase, snap, occupancy and funds without partial purchases', () => {
  const g = G.newGame();
  assert.match(G.placeShooter(g, defender, 0), /begin/);
  G.start(g, [spawner, defender]);
  assert.match(G.placeShooter(g, defender, 0), /begin/);
  advance(g, 300);
  for (const role of ['Spawner', 'Spectator']) assert.match(G.placeShooter(g, { ...defender, role }, 0), /Only/);
  for (const id of [-1, 16, '0', null, NaN, 1.5]) assert.match(G.placeShooter(g, defender, id), /Invalid/);
  assert.equal(g.treasury, 150); assert.equal(g.towers.length, 0);
  assert.equal(G.placeShooter(g, defender, 0), null);
  assert.equal(g.treasury, 100);
  assert.equal(g.towers[0].ownerId, defender.playerId);
  assert.deepEqual({ x: g.towers[0].x, y: g.towers[0].y }, C.map.snapPoints[0]);
  assert.match(G.placeShooter(g, { ...defender, playerId: 'other' }, 0), /occupied/);
  assert.equal(g.treasury, 100); assert.equal(g.spendFeed.length, 1);
  assert.equal(g.spendFeed[0].nickname, 'Sam'); assert.equal(g.spendFeed[0].cost, 50);
  g.treasury = 49; assert.match(G.placeShooter(g, defender, 1), /treasury/i);
  assert.equal(g.towers.length, 1); assert.equal(g.treasury, 49);
  g.phase = 'finished'; assert.match(G.placeShooter(g, defender, 1), /begin/);
});

test('all 16 fixed points are usable with no Defender-count scaling cap', () => {
  const g = playing(); g.treasury = 800;
  for (let snapId = 0; snapId < 16; snapId++) assert.equal(G.placeShooter(g, defender, snapId), null);
  assert.equal(g.towers.length, 16); assert.equal(g.treasury, 0);
  assert.equal(g.spendFeed.length, C.ui.spendFeedLimit);
});

test('ten seconds of shared income funds a Shooter exactly, without floating-point purchase delays', () => {
  const g = playing();
  for (const id of [0, 4, 8]) G.placeShooter(g, defender, id);
  assert.equal(g.treasury, 0);
  advance(g, 300);
  assert.equal(g.treasury, 50);
  assert.equal(G.placeShooter(g, defender, 12), null);
  assert.equal(g.treasury, 0);
});

test('Shooter targets closest to Core in range, fires twice/sec, and pays a kill exactly once', () => {
  const g = playing(); G.placeShooter(g, defender, 0);
  // Snap 0 is (810,400). ID 30 is closest to Core but outside range;
  // ID 20 is closest to the tower; ID 10 is the eligible Core threat.
  g.enemies = [runner(20, 814, 400), runner(30, 600, 500), runner(10, 704, 400)];
  G.step(g);
  assert.equal(g.enemies.find(e => e.id === 10).hp, 8);
  assert.equal(g.enemies.find(e => e.id === 20).hp, 20);
  assert.equal(g.enemies.find(e => e.id === 30).hp, 20);
  assert.equal(g.towers[0].lastShot.targetId, 10);
  // Keep the wounded target in range to isolate cadence from movement.
  g.enemies = [runner(10, 830, 400)]; g.enemies[0].hp = 8;
  advance(g, 14); assert.equal(g.enemies[0].hp, 8);
  G.step(g); assert.equal(g.enemies.length, 0);
  assert.equal(g.towers[0].kills, 1); assert.equal(g.towers[0].damageDealt, 20);
  assert.ok(Math.abs(g.treasury - (100 + 16 / 30 * 5 + 6)) < 1e-8);
  advance(g, 30); assert.equal(g.towers[0].kills, 1);
});

test('equal Core distances break ties by enemy ID; two towers cannot double-pay a kill', () => {
  const tie = playing(); G.placeShooter(tie, defender, 0);
  tie.enemies = [runner(20, 800, 420), runner(10, 800, 380)]; G.step(tie);
  assert.equal(tie.towers[0].lastShot.targetId, 10);
  const g = playing(); G.placeShooter(g, defender, 0); G.placeShooter(g, { ...defender, playerId: 'second' }, 1);
  g.enemies = [runner(99, 810, 420)]; g.enemies[0].hp = 8; G.step(g);
  assert.equal(g.enemies.length, 0);
  assert.equal(g.towers.reduce((sum, t) => sum + t.kills, 0), 1);
  assert.equal(g.towers.reduce((sum, t) => sum + t.damageDealt, 0), 8);
  assert.ok(Math.abs(g.treasury - (50 + 5 / 30 + 6)) < 1e-8);
});

test('a top Shooter kills a spawned Runner before it can hit the Core; snapshots carry HP and ownership', () => {
  const g = playing(); G.placeShooter(g, defender, 12); G.spawnRunner(g, 'Spawner', 0);
  advance(g, 60); assert.equal(g.enemies[0].hp, 20);
  advance(g, 10); assert.equal(g.enemies[0].hp, 8);
  advance(g, 15); assert.equal(g.enemies.length, 0); assert.equal(g.coreHP, 100);
  assert.ok(Math.abs(g.treasury - (100 + 85 / 30 * 5 + 6)) < 1e-8);
  const s = G.snapshot(g);
  assert.equal(s.towers[0].ownerId, 'defender'); assert.equal(s.towers[0].kills, 1);
  s.towers[0].lastShot.x = 0; s.spendFeed[0].cost = 999;
  assert.notEqual(g.towers[0].lastShot.x, 0); assert.equal(g.spendFeed[0].cost, 50);
});
