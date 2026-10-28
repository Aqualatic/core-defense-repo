const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const G = require('../server/game');
const sam = { playerId: 'sam', nickname: 'Sam', role: 'Defender', connected: true };
const lee = { playerId: 'lee', nickname: 'Lee', role: 'Defender', connected: true };
function advance(g, count) { for (let i = 0; i < count; i++) G.step(g); }
function game() {
  const g = G.newGame();
  G.start(g, [{ playerId: 'attack', role: 'Spawner', connected: true }, sam, lee]);
  advance(g, 300); return g;
}
const enemy = (id, x, y = 400, hp = 20) => ({ id, type: 'Runner', x, y, hp });
const score = (g, id) => G.snapshot(g).scores.find(s => s.playerId === id);

test('Cannon and Freezer validate type, charge configured costs and keep stable ownership', () => {
  for (const type of ['Cannon', 'Freezer']) {
    const g = game();
    assert.equal(G.placeTower(g, sam, 0, type), null);
    assert.equal(g.treasury, 160 - C.towers[type].cost);
    assert.equal(g.towers[0].type, type); assert.equal(g.towers[0].ownerId, 'sam');
  }
  const g = game();
  for (const type of ['constructor', '__proto__', 'Laser', null, {}]) assert.match(G.placeTower(g, sam, 0, type), /Invalid tower/);
  assert.equal(g.treasury, 160); assert.equal(g.towers.length, 0);
});

test('Cannon splash reaches enemies outside tower range but not outside the splash circle', () => {
  const g = game(); G.placeTower(g, sam, 0, 'Cannon');
  g.enemies = [enemy(10, 954), enemy(20, 990), enemy(30, 1008)];
  G.step(g);
  assert.deepEqual(g.enemies.map(e => e.id), [30]);
  assert.equal(g.enemies[0].hp, 20);
  assert.equal(g.towers[0].lastShot.targetId, 10);
  assert.equal(score(g, 'sam').damage, 40); assert.equal(score(g, 'sam').kills, 2);
  assert.equal(score(g, 'sam').points, 60); // 40 actual damage + 2 * 10 kills, never 160 overkill damage.
  assert.ok(Math.abs(g.treasury - (40 + 5 / 30 + 12)) < 1e-8);
  g.enemies = []; advance(g, 59);
  g.enemies = [enemy(40, 954)]; G.step(g);
  assert.equal(g.towers[0].kills, 3); // Exactly 60 ticks between Cannon shots.
});

test('Freezer hits every enemy in range, deals zero damage and overlap never multiplies the slow', () => {
  const g = game(); g.treasury = 500;
  G.placeTower(g, sam, 0, 'Freezer'); G.placeTower(g, lee, 1, 'Freezer');
  g.enemies = [enemy(10, 810, 420), enemy(20, 810, 440), enemy(30, 1100)];
  G.step(g);
  assert.equal(g.enemies[0].slows.length, 2); assert.equal(g.enemies[1].slows.length, 2);
  assert.equal(g.enemies[2].slows.length, 0);
  const before = g.enemies.map(e => ({ x: e.x, y: e.y }));
  G.step(g);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(Math.hypot(g.enemies[i].x - before[i].x, g.enemies[i].y - before[i].y) - (i === 2 ? 4 : 2)) < 1e-8);
    assert.equal(g.enemies[i].hp, 20);
  }
  assert.equal(score(g, 'sam').points, 0); assert.equal(score(g, 'lee').points, 0);
});

test('slow lasts exactly 60 movement ticks, refreshes at pulse cadence and uses only the strongest active effect', () => {
  const g = game(); G.placeTower(g, sam, 0, 'Freezer');
  g.enemies = [enemy(10, 850)]; G.step(g);
  const t = g.towers[0], e = g.enemies[0], startX = e.x;
  t.disabled = true; advance(g, 60);
  assert.ok(Math.abs(e.x - (startX - 120)) < 1e-8);
  G.step(g); assert.ok(Math.abs(e.x - (startX - 124)) < 1e-8);
  e.x = 850; e.slows = [
    { towerId: 100, ownerId: 'sam', multiplier: 0.25, untilTick: g.matchTick + 2 },
    { towerId: 101, ownerId: 'lee', multiplier: 0.5, untilTick: g.matchTick + 5 }
  ];
  G.step(g); assert.equal(e.x, 849);
  G.step(g); assert.equal(e.x, 848);
  G.step(g); assert.equal(e.x, 846); // The weaker effect resumes after the stronger one expires.
  const refresh = game(); G.placeTower(refresh, sam, 0, 'Freezer');
  refresh.enemies = [enemy(99, 850)]; G.step(refresh);
  advance(refresh, 29); assert.equal(refresh.enemies[0].slows[0].untilTick, 61);
  G.step(refresh); assert.equal(refresh.enemies[0].slows[0].untilTick, 91);
});

test('assists are once per distinct Freezer owner on a slowed kill, not on pulses or Core hits', () => {
  const g = game(); g.treasury = 1000;
  G.placeTower(g, sam, 0, 'Freezer'); G.placeTower(g, sam, 1, 'Freezer');
  G.placeTower(g, lee, 15, 'Freezer'); G.placeTower(g, lee, 2, 'Cannon');
  // All Freezers and Cannon cover this point; Cannon fires after the slow pulses.
  g.enemies = [enemy(10, 800, 410)]; G.step(g);
  assert.equal(g.enemies.length, 0);
  assert.equal(score(g, 'sam').assists, 1); assert.equal(score(g, 'sam').points, 5);
  assert.equal(score(g, 'lee').kills, 1); assert.equal(score(g, 'lee').damage, 20);
  assert.equal(score(g, 'lee').assists, 1); assert.equal(score(g, 'lee').points, 35);
  advance(g, 30); assert.equal(score(g, 'sam').assists, 1);
  g.enemies = [enemy(20, 600, 399)];
  g.enemies[0].slows = [{ towerId: 1, ownerId: 'sam', multiplier: 0.5, untilTick: g.matchTick + 60 }];
  G.step(g); assert.equal(g.coreHP, 97); assert.equal(score(g, 'sam').assists, 1);
});

test('selling is owner-only after exactly one second, refunds once and never deletes earned scores', () => {
  for (const [type, refund] of [['Shooter', 25], ['Cannon', 60], ['Freezer', 45]]) {
    const g = game(); G.placeTower(g, sam, 0, type); const id = g.towers[0].id;
    assert.match(G.sellTower(g, sam, id), /locked/);
    advance(g, 29); assert.match(G.sellTower(g, sam, id), /locked/);
    G.step(g); assert.match(G.sellTower(g, lee, id), /owner/);
    assert.match(G.sellTower(g, { ...sam, role: 'Spectator' }, id), /Only/);
    const before = g.treasury;
    assert.equal(G.sellTower(g, sam, id), null); assert.equal(g.treasury, before + refund);
    assert.match(G.sellTower(g, sam, id), /not found/); assert.equal(g.treasury, before + refund);
    assert.equal(g.spendFeed.at(-1).action, 'sold');
    assert.equal(G.placeTower(g, sam, 0, 'Shooter'), null);
    assert.notEqual(g.towers[0].id, id); assert.match(G.sellTower(g, sam, id), /not found/);
  }
  const g = game(); G.placeTower(g, sam, 0, 'Cannon'); const id = g.towers[0].id;
  g.enemies = [enemy(10, 850)]; G.step(g); advance(g, 29);
  G.sellTower(g, sam, id);
  assert.equal(score(g, 'sam').points, 30); assert.equal(score(g, 'sam').damage, 20);
});

test('upkeep is per tower from placement time; unpaid towers pause until a paid billing interval', () => {
  const g = game(); G.placeTower(g, sam, 0, 'Shooter');
  advance(g, 150); G.placeTower(g, lee, 1, 'Shooter');
  advance(g, 149); const before = g.treasury; G.step(g);
  assert.ok(Math.abs(g.treasury - (before + 5 / 30 - 1)) < 1e-8);
  assert.equal(g.towers[0].nextUpkeepTick, 600); assert.equal(g.towers[1].nextUpkeepTick, 450);
  const paused = game(); G.placeTower(paused, sam, 0, 'Shooter'); advance(paused, 299);
  paused.treasury = 0; paused.treasuryError = 0; paused.enemies = [enemy(10, 850)];
  G.step(paused); assert.equal(paused.towers[0].disabled, true); assert.equal(paused.enemies[0].hp, 20);
  advance(paused, 299); assert.equal(paused.towers[0].disabled, true);
  paused.enemies = [enemy(20, 850)]; G.step(paused);
  assert.equal(paused.towers[0].disabled, false); assert.equal(paused.enemies[0].hp, 8);
  assert.ok(paused.treasury >= 0);
});

test('sold Freezer effects can finish their duration; expired or weaker effects get no assist', () => {
  const g = game(); g.treasury = 500;
  G.placeTower(g, sam, 0, 'Freezer'); advance(g, 30);
  const freezer = g.towers[0];
  g.enemies = [enemy(10, 850)]; G.step(g);
  assert.equal(G.sellTower(g, sam, freezer.id), null);
  G.placeTower(g, lee, 0, 'Cannon'); G.step(g);
  assert.equal(score(g, 'sam').assists, 1); assert.equal(score(g, 'lee').points, 30);
  const fresh = game(); G.placeTower(fresh, sam, 0, 'Cannon');
  fresh.enemies = [enemy(10, 850)];
  fresh.enemies[0].slows = [
    { ownerId: 'lee', multiplier: 0.5, untilTick: 1 }, // Expires at kill tick.
    { ownerId: 'lee', multiplier: 0.75, untilTick: 50 },
    { ownerId: 'sam', multiplier: 0.5, untilTick: 50 }
  ];
  G.step(fresh);
  assert.equal(score(fresh, 'lee'), undefined); assert.equal(score(fresh, 'sam').assists, 1);
});

test('selling before upkeep stops future charges; finished matches freeze billing, slows and scoring', () => {
  const g = game(); G.placeTower(g, sam, 0, 'Shooter'); advance(g, 299);
  const id = g.towers[0].id; G.sellTower(g, sam, id); const before = g.treasury;
  G.step(g); assert.ok(Math.abs(g.treasury - (before + 5 / 30)) < 1e-8);
  G.placeTower(g, sam, 0, 'Freezer'); g.enemies = [enemy(100, 850)]; G.step(g);
  g.phase = 'finished';
  const frozen = G.snapshot(g); advance(g, 600);
  const after = G.snapshot(g);
  assert.equal(after.treasury, frozen.treasury); assert.deepEqual(after.enemies, frozen.enemies);
  assert.deepEqual(after.scores, frozen.scores);
  assert.match(G.sellTower(g, sam, g.towers[0].id), /begin/);
});
