const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../server/game');
const C = require('../shared/config');
const a = { playerId: 'a', nickname: 'Attack', role: 'Spawner', connected: true };
const d = { playerId: 'd', nickname: 'Build', role: 'Defender', connected: true };
function advance(g, n) { for (let i = 0; i < n; i++) G.step(g); }
function playing() { const g = G.newGame(); G.start(g, [a, d]); advance(g, 300); return g; }

test('Core Repair rejects full HP, wrong roles, wrong phase and insufficient funds without taking money or cooldown', () => {
  const g = playing(); assert.match(G.repairCore(g, d), /full/);
  assert.equal(g.treasury, 150); assert.equal(G.snapshot(g).repairCooldown, 0);
  g.coreHP = 97; assert.match(G.repairCore(g, a), /Only/);
  g.treasury = 59; assert.match(G.repairCore(g, d), /Treasury/);
  assert.equal(g.coreHP, 97); assert.equal(G.snapshot(g).repairCooldown, 0);
  g.phase = 'countdown'; assert.match(G.repairCore(g, d), /begin/);
});

test('Repair costs the full 60 for a partial heal, awards 10, and shares an exact 20-second cooldown', () => {
  const g = playing(); g.coreHP = 97;
  assert.equal(G.repairCore(g, d), null); assert.equal(g.coreHP, 100); assert.equal(g.treasury, 90);
  assert.equal(g.scores.find(s => s.playerId === 'd').points, 10);
  assert.equal(g.spendFeed.at(-1).healed, 3);
  g.coreHP = 90; const other = { ...d, playerId: 'second' };
  assert.match(G.repairCore(g, other), /cooldown/);
  advance(g, 599); assert.match(G.repairCore(g, other), /cooldown/);
  G.step(g); assert.equal(G.repairCore(g, other), null); assert.equal(g.coreHP, 95);
  assert.equal(g.scores.find(s => s.playerId === 'second').points, 10);
});

test('winning-side bonus is awarded once to match participants, including offline owners but not spectators', () => {
  const g = playing(); g.scores.find(s => s.playerId === 'd').connected = false;
  g.matchTick = 8999; G.step(g);
  assert.equal(g.scores.find(s => s.playerId === 'd').points, 100);
  assert.equal(g.scores.find(s => s.playerId === 'a').points, 0);
  assert.equal(g.scores.find(s => s.playerId === 'd').winBonus, 100);
  advance(g, 60); assert.equal(g.scores.find(s => s.playerId === 'd').points, 100);
});

test('diagnostics count exactly cooldown-only seconds per type without double-counting the aggregate', () => {
  const g = playing(); G.spawnEnemy(g, 'Spawner', 'Runner', 0); advance(g, 45);
  let s = G.snapshot(g).spawnDiagnostics;
  assert.equal(s.perTypeSeconds.Runner, 1.5); assert.equal(s.anyTypeSeconds, 1.5);
  assert.equal(s.allAffordableSeconds, 0); // Tank and Swarm remained affordable and ready.
  const stalled = playing(); stalled.money = 40;
  G.spawnEnemy(stalled, 'Spawner', 'Runner', 0); advance(stalled, 45);
  s = G.snapshot(stalled).spawnDiagnostics;
  assert.equal(s.perTypeSeconds.Runner, 1.5); assert.equal(s.allAffordableSeconds, 1.5);
  advance(stalled, 30); assert.equal(G.snapshot(stalled).spawnDiagnostics.anyTypeSeconds, 1.5);
});

test('diagnostics exclude insufficient-money, capacity, countdown and finished intervals', () => {
  const g = playing(); g.money = 20; G.spawnEnemy(g, 'Spawner', 'Runner', 0); advance(g, 45);
  assert.equal(G.snapshot(g).spawnDiagnostics.perTypeSeconds.Runner, 0);
  const capped = playing(); G.spawnEnemy(capped, 'Spawner', 'Runner', 0);
  capped.warnings.push(...Array.from({ length: 79 }, (_, i) => ({ id: i + 100, type: 'Tank', releaseTick: 9000, gateId: 0 })));
  advance(capped, 45); assert.equal(G.snapshot(capped).spawnDiagnostics.anyTypeSeconds, 0);
  const lobby = G.newGame(); G.start(lobby, [a, d]); advance(lobby, 300);
  assert.equal(G.snapshot(lobby).spawnDiagnostics.anyTypeSeconds, 0);
  lobby.phase = 'finished'; advance(lobby, 60);
  assert.equal(G.snapshot(lobby).spawnDiagnostics.anyTypeSeconds, 0);
});
