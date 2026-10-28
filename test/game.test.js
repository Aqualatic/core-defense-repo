const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const G = require('../server/game');
const players = [{ role: 'Spawner', connected: true }, { role: 'Defender', connected: true }];
function advance(g, count) { for (let i = 0; i < count; i++) G.step(g); }
function playing() { const g = G.newGame(); G.start(g, players); advance(g, 300); return g; }

test('10-second countdown has no income, no actions, and no match time', () => {
  const g = G.newGame();
  assert.match(G.start(g, players.slice(0, 1)), /required/);
  assert.equal(G.start(g, players), null);
  assert.match(G.spawnRunner(g, 'Spawner', 0), /begin/);
  advance(g, 299); assert.equal(g.phase, 'countdown');
  assert.equal(g.money, 150); assert.equal(g.matchTick, 0);
  G.step(g); assert.equal(g.phase, 'playing'); assert.equal(g.money, 150);
  advance(g, 30); assert.ok(Math.abs(g.money - 154.5) < 1e-9);
});
test('spawn charges immediately, warns for exactly 60 ticks, then moves at 120px/s', () => {
  const g = playing();
  assert.equal(G.spawnRunner(g, 'Spawner', 0), null);
  assert.equal(g.money, 130); assert.equal(G.snapshot(g).runnerCooldown, 1.5);
  assert.match(G.spawnRunner(g, 'Spawner', 1), /cooldown/);
  advance(g, 59); assert.equal(g.enemies.length, 0); assert.equal(g.warnings.length, 1);
  G.step(g); assert.equal(g.warnings.length, 0);
  assert.equal(g.enemies[0].y, 30);
  advance(g, 30); assert.equal(g.enemies[0].x, 600); assert.equal(g.enemies[0].y, 150);
  advance(g, 63); assert.equal(g.enemies.length, 0); assert.equal(g.coreHP, 97);
  assert.ok(Math.abs(g.money - (130 + 153 / 30 * 4.5 + 5)) < 1e-8);
});
test('every gate follows a straight line, hits once and disappears', () => {
  C.map.spawnGates.forEach((gate, gateId) => {
    const g = playing(); G.spawnRunner(g, 'Spawner', gateId); advance(g, 60);
    advance(g, 30);
    const e = g.enemies[0], length = Math.hypot(600 - gate.x, 400 - gate.y);
    assert.ok(Math.abs(e.x - (gate.x + (600 - gate.x) * 120 / length)) < 1e-7);
    assert.ok(Math.abs(e.y - (gate.y + (400 - gate.y) * 120 / length)) < 1e-7);
    advance(g, 200); assert.equal(g.coreHP, 97); assert.equal(g.enemies.length, 0);
  });
});
test('invalid gate, Defender, insufficient funds, and cap are rejected without charge', () => {
  const g = playing();
  for (const id of [-1, 8, '0', NaN, null]) assert.match(G.spawnRunner(g, 'Spawner', id), /Invalid/);
  assert.match(G.spawnRunner(g, 'Defender', 0), /Only/); assert.equal(g.money, 150);
  g.money = 19; assert.match(G.spawnRunner(g, 'Spawner', 0), /money/); assert.equal(g.money, 19);
  g.money = 150; g.warnings = Array.from({ length: 80 }, () => ({}));
  assert.match(G.spawnRunner(g, 'Spawner', 0), /cap/); assert.equal(g.money, 150);
});
test('N is captured at start; disconnected roster changes do not change income', () => {
  const roster = [players[0], ...Array.from({ length: 7 }, () => ({ ...players[1] }))];
  const g = G.newGame(); G.start(g, roster); roster.pop(); advance(g, 330);
  assert.equal(g.n, 7); assert.ok(Math.abs(g.money - 157.5) < 1e-8);
});
test('Core destruction wins on the deadline; finished matches are frozen', () => {
  const g = playing(); g.matchTick = 8999; g.coreHP = 3;
  g.enemies.push({ id: 1, x: 600, y: 399 }); G.step(g);
  assert.equal(g.phase, 'finished'); assert.match(g.reason, /Spawner/);
  const money = g.money; advance(g, 300); assert.equal(g.money, money); assert.equal(g.matchTick, 9000);
  const survivor = playing(); advance(survivor, 9000); assert.match(survivor.reason, /Defenders/);
});
