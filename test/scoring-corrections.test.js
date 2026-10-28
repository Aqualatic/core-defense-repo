const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../server/game');
const C = require('../shared/config');
const sam = { playerId: 'sam', nickname: 'Sam', role: 'Defender', connected: true };
const lee = { playerId: 'lee', nickname: 'Lee', role: 'Defender', connected: true };
function advance(g, n) { for (let i = 0; i < n; i++) G.step(g); }
function playing() {
  const g = G.newGame(); G.start(g, [{ playerId: 'a', role: 'Spawner', connected: true }, sam, lee]);
  advance(g, 300); g.treasury = 1000; return g;
}
const score = (g, id) => g.scores.find(s => s.playerId === id);
const enemy = (id, type = 'Tank', x = 850) => ({ id, type, x, y: 400, hp: C.enemies[type].hp, slows: [] });

test('Freezer awards 2 per application immediately, globally no more than once per enemy every two seconds', () => {
  const g = playing(); G.placeTower(g, sam, 0, 'Freezer'); G.placeTower(g, lee, 1, 'Freezer');
  g.enemies = [enemy(100)]; G.step(g);
  assert.equal(score(g, 'sam').points, 2); assert.equal(score(g, 'lee').points, 0);
  assert.equal(g.enemies[0].hp, 300); assert.equal(score(g, 'sam').assists, 1);
  advance(g, 59); assert.equal(score(g, 'sam').points, 2);
  G.sellTower(g, sam, g.towers[0].id); G.step(g);
  assert.equal(score(g, 'lee').points, 2); // Selling/rebuying does not reset the enemy's timer.
});

test('each Freezer awards at most 10 points in a rolling one-second window without limiting actual slow applications', () => {
  const g = playing(); G.placeTower(g, sam, 0, 'Freezer');
  g.enemies = Array.from({ length: 8 }, (_, i) => enemy(100 + i));
  G.step(g); assert.equal(score(g, 'sam').points, 10); assert.equal(score(g, 'sam').assists, 5);
  assert.ok(g.enemies.every(e => e.slows.length === 1));
  advance(g, 29); assert.equal(score(g, 'sam').points, 10);
  G.step(g); assert.equal(score(g, 'sam').points, 16); // The other three enemies can now earn an award.
  advance(g, 30); assert.equal(score(g, 'sam').points, 26);
  assert.ok(g.towers[0].assistAwardTicks.length <= 5);
});

test('kills no longer award Freezer assists; damage and kill points use the corrected multipliers', () => {
  const g = playing(); G.placeTower(g, sam, 0, 'Freezer'); G.placeTower(g, lee, 1, 'Cannon');
  g.enemies = [enemy(100, 'Runner', 800)]; G.step(g);
  assert.equal(g.enemies.length, 0); assert.equal(score(g, 'sam').points, 2);
  assert.equal(score(g, 'lee').points, 25); assert.equal(score(g, 'lee').damage, 20);
  const before = score(g, 'sam').points; advance(g, 60); assert.equal(score(g, 'sam').points, before);
  g.enemies = [enemy(101, 'Tiny', 800)]; G.step(g);
  assert.equal(score(g, 'lee').points, 33.75); // 15*.25 + 5.
});

test('upkeep transition produces a single pause note and a single resume note on successful payment', () => {
  const g = playing(); G.placeTower(g, sam, 0, 'Shooter'); advance(g, 299);
  g.treasury = 0; g.treasuryError = 0; G.step(g);
  assert.equal(g.towers[0].disabled, true); assert.equal(g.spendFeed.at(-1).action, 'paused');
  const length = g.spendFeed.length; advance(g, 299); assert.equal(g.spendFeed.length, length);
  G.step(g); assert.equal(g.towers[0].disabled, false);
  assert.equal(g.spendFeed.at(-1).action, 'resumed'); assert.equal(g.spendFeed.at(-1).cost, 1);
  const resumedLength = g.spendFeed.length; advance(g, 30); assert.equal(g.spendFeed.length, resumedLength);
});

test('owner-only sell/rebuy transactions always lose half the cost and cannot mint money or points', () => {
  for (const [type, loss] of [['Shooter', 25], ['Cannon', 60], ['Freezer', 45]]) {
    const g = playing(); G.placeTower(g, sam, 0, type); advance(g, 30);
    const id = g.towers[0].id, before = g.treasury;
    assert.match(G.sellTower(g, lee, id), /owner/);
    G.sellTower(g, sam, id); G.placeTower(g, sam, 0, type);
    assert.equal(g.treasury, before - loss); assert.equal(score(g, 'sam').points, 0);
    assert.match(G.sellTower(g, sam, id), /not found/);
    assert.match(G.sellTower(g, sam, g.towers[0].id), /locked/);
  }
});
