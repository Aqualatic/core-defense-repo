const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const G = require('../server/game');
const attacker = { playerId: 'a', nickname: 'Attack', role: 'Spawner', connected: true };
const defender = { playerId: 'd', nickname: 'Build', role: 'Defender', connected: true };
function advance(g, n) { for (let i = 0; i < n; i++) G.step(g); }
function playing() { const g = G.newGame(); G.start(g, [attacker, defender]); advance(g, 300); return g; }
const enemy = (id, type, x, y = 400, hp = C.enemies[type].hp) => ({ id, type, x, y, hp, slows: [] });

test('each selectable enemy pays at acceptance, uses one per-type cooldown across all gates, and warns for two seconds', () => {
  for (const [type, cost, speed, cooldown] of [['Runner', 20, 120, 1.5], ['Tank', 80, 35, 8], ['Swarm', 60, 65, 6]]) {
    const g = playing();
    assert.equal(G.spawnEnemy(g, 'Spawner', type, 0), null);
    assert.equal(g.money, 150 - cost); assert.equal(G.snapshot(g).spawns[type].cooldown, cooldown);
    assert.match(G.spawnEnemy(g, 'Spawner', type, 1), /cooldown/);
    advance(g, 59); assert.equal(g.enemies.length, 0);
    G.step(g); assert.equal(g.enemies[0].type, type); assert.equal(g.enemies[0].y, 30);
    advance(g, 30); assert.ok(Math.abs(g.enemies[0].y - (30 + speed)) < 1e-8);
  }
  const g = playing();
  for (const type of ['Tiny', 'constructor', null, 'Laser']) assert.match(G.spawnEnemy(g, 'Spawner', type, 0), /Invalid enemy/);
  assert.match(G.spawnEnemy(g, 'Defender', 'Tank', 0), /Only/);
  G.spawnEnemy(g, 'Spawner', 'Runner', 0);
  assert.equal(G.spawnEnemy(g, 'Spawner', 'Tank', 1), null);
  assert.equal(g.money, 50); assert.equal(g.warnings.length, 2);
});

test('Tank and Tiny deal configured Core damage and Spawner points for actual HP removed', () => {
  for (const [type, damage] of [['Runner', 3], ['Tank', 15], ['Tiny', 2]]) {
    const g = playing(); g.enemies = [enemy(100, type, 600, 400)]; G.step(g);
    assert.equal(g.coreHP, 100 - damage); assert.equal(g.enemies.length, 0);
    assert.equal(g.scores.find(s => s.playerId === 'a').points, damage * 5);
  }
  const g = playing(); g.coreHP = 1;
  g.enemies = [enemy(100, 'Tank', 600), enemy(101, 'Tank', 600)]; G.step(g);
  const score = g.scores.find(s => s.playerId === 'a');
  assert.equal(g.coreHP, 0); assert.equal(score.coreDamage, 1); assert.equal(score.points, 105);
  assert.ok(Math.abs(g.money - (150 + 4.5 / 30 + 5)) < 1e-8);
});

test('a tower-killed Swarm pays 18, credits its kill, and splits once into five full-health Tinies', () => {
  const g = playing(); G.placeTower(g, defender, 0, 'Cannon');
  g.enemies = [enemy(100, 'Swarm', 850, 400, 80)]; G.step(g);
  assert.equal(g.enemies.length, 5); assert.ok(g.enemies.every(e => e.type === 'Tiny' && e.hp === 15));
  assert.equal(new Set(g.enemies.map(e => e.id)).size, 5);
  assert.equal(G.snapshot(g).enemySlots.used, 5);
  assert.ok(Math.abs(g.treasury - (30 + 5 / 30 + 18)) < 1e-8);
  assert.equal(g.scores.find(s => s.playerId === 'd').points, 40); // 80 damage * .25 + 20 kill.
  advance(g, 60);
  assert.equal(g.enemies.length, 0);
  const s = g.scores.find(s => s.playerId === 'd');
  assert.equal(s.kills, 6); assert.equal(s.points, 83.75); // Five Tinies: 75 damage*.25 + 5*5 kills.
  assert.ok(Math.abs(g.treasury - (30 + 61 / 30 * 5 + 23)) < 1e-8);
});

test('proximity split at 150px pays no parent bounty or kill; all Tinies can hit the Core', () => {
  const g = playing(); g.enemies = [enemy(100, 'Swarm', 751)];
  G.step(g); assert.equal(g.enemies.length, 5); assert.ok(g.enemies.every(e => e.type === 'Tiny'));
  assert.equal(g.scores.find(s => s.playerId === 'd').kills, 0);
  assert.ok(Math.abs(g.treasury - (150 + 5 / 30)) < 1e-8);
  advance(g, 60); assert.equal(g.coreHP, 90); assert.equal(g.enemies.length, 0);
  assert.equal(g.scores.find(s => s.playerId === 'a').points, 50);
});

test('proximity split takes precedence over a same-tick shot; the shot can kill Tinies but not claim the parent bounty', () => {
  const g = playing(); G.placeTower(g, defender, 0, 'Cannon');
  g.enemies = [enemy(100, 'Swarm', 751)]; G.step(g);
  assert.equal(g.enemies.length, 0);
  assert.equal(g.scores.find(s => s.playerId === 'd').kills, 5);
  assert.ok(Math.abs(g.treasury - (30 + 5 / 30 + 5)) < 1e-8);
});

test('75 used slots accept a five-slot Swarm, 76 reject it, and 80 reject all spawns without charge', () => {
  for (const [used, accepted] of [[75, true], [76, false], [80, false]]) {
    const g = playing(); g.enemies = Array.from({ length: used }, (_, i) => enemy(100 + i, 'Tank', 1100));
    const result = G.spawnEnemy(g, 'Spawner', 'Swarm', 0);
    assert.equal(result === null, accepted);
    assert.equal(g.money, accepted ? 90 : 150);
    assert.equal(G.snapshot(g).spawns.Swarm.cooldown, accepted ? 6 : 0);
    assert.equal(G.snapshot(g).enemySlots.used, accepted ? 80 : used);
  }
  const g = playing(); g.warnings = Array.from({ length: 16 }, (_, i) => ({ id: 100 + i, type: 'Swarm', gateId: 0, releaseTick: 60 }));
  assert.equal(G.snapshot(g).enemySlots.used, 80);
  assert.match(G.spawnEnemy(g, 'Spawner', 'Runner', 0), /cap/);
  advance(g, 60); assert.equal(g.enemies.length, 16); assert.equal(G.snapshot(g).enemySlots.used, 80);
  g.enemies.forEach(e => { e.x = 750; e.y = 400; }); G.step(g);
  assert.equal(g.enemies.length, 80); assert.equal(G.snapshot(g).enemySlots.used, 80);
  assert.ok(g.enemies.every(e => e.type === 'Tiny'));
});

test('a killed Swarm at full reserved capacity still produces every Tiny, then released slots become reusable', () => {
  const g = playing(); G.placeTower(g, defender, 0, 'Cannon');
  g.enemies = [...Array.from({ length: 75 }, (_, i) => enemy(100 + i, 'Tank', 600, 30)), enemy(200, 'Swarm', 850, 400, 80)];
  assert.equal(G.snapshot(g).enemySlots.used, 80); G.step(g);
  assert.equal(g.enemies.filter(e => e.type === 'Tiny').length, 5);
  assert.equal(g.enemies.length, 80); assert.equal(G.snapshot(g).enemySlots.used, 80);
  advance(g, 60); assert.equal(G.snapshot(g).enemySlots.used, 75);
  assert.equal(G.spawnEnemy(g, 'Spawner', 'Swarm', 0), null);
});
