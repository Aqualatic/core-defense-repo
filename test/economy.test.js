const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const G = require('../server/game');
const players = [{ playerId: 'a', nickname: 'Attack', role: 'Spawner', connected: true },
  { playerId: 'd', nickname: 'Build', role: 'Defender', connected: true }];
const advance = (engine, game, count) => { for (let i = 0; i < count; i++) engine.step(game); };
function playing(engine = G, n = 1) {
  const game = engine.newGame();
  engine.start(game, [players[0], ...Array.from({ length: n }, (_, i) => ({ ...players[1], playerId: 'd' + i }))]);
  advance(engine, game, C.match.countdownSeconds * C.network.tickHz);
  return game;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function reconciles(side) {
  near(side.startingBalance + side.totalIncome - side.totalSpent, side.finalBalance);
  near(Object.values(side.income).reduce((a, b) => a + b, 0), side.totalIncome);
  near(Object.values(side.spent).reduce((a, b) => a + b, 0), side.totalSpent);
}

test('default upkeep is unchanged; opt-in slope counts all towers at the time a bill is due', () => {
  assert.equal(C.upkeep.upkeepSlope, 0); assert.equal(C.economy.coreHitReward, 5);
  const custom = structuredClone(C); custom.upkeep.upkeepSlope = 0.125;
  const engine = G.createEngine(custom), game = playing(engine);
  game.treasury = 2000;
  for (let i = 0; i < 16; i++) engine.placeTower(game, players[1], i);
  game.towers[0].disabled = true;
  assert.equal(engine.snapshot(game).upkeepPerTower, 2);
  const before = game.treasury; advance(engine, game, 300);
  near(game.treasury, before + 50 - 32);
  assert.equal(game.towers[0].disabled, false);
  engine.sellTower(game, players[1], game.towers[0].id);
  assert.equal(engine.snapshot(game).upkeepPerTower, 1.875);
  assert.equal(C.upkeep.upkeepSlope, 0);
  assert.equal(G.snapshot(game).upkeepPerTower, 1); // Independent engine configuration.
});

test('logs sample 0, 30 through 300 match seconds, freeze after finish and reconcile both wallets', () => {
  const game = G.newGame(); G.start(game, players);
  assert.equal(G.economySummary(game).samples.length, 0);
  advance(G, game, 299); assert.equal(G.economySummary(game).samples.length, 0);
  G.step(game); assert.deepEqual(G.economySummary(game).samples, [{ seconds: 0, treasury: 150, spawnerMoney: 150 }]);
  advance(G, game, 9000);
  const summary = G.economySummary(game);
  assert.deepEqual(summary.samples.map(s => s.seconds), [0,30,60,90,120,150,180,210,240,270,300]);
  assert.equal(summary.defenders.totalIncome, 1500); assert.equal(summary.spawner.totalIncome, 1350);
  assert.equal(summary.defenders.finalBalance, 1650); assert.equal(summary.spawner.finalBalance, 1500);
  reconciles(summary.defenders); reconciles(summary.spawner);
  advance(G, game, 300); assert.deepEqual(G.economySummary(game), summary);
});

test('ledger accounts for purchases, bounties, upkeep, refunds, repairs and configurable Core-hit money', () => {
  const custom = structuredClone(C); custom.economy.coreHitReward = 10;
  const engine = G.createEngine(custom), game = playing(engine);
  engine.placeTower(game, players[1], 12, 'Shooter');
  engine.spawnEnemy(game, 'Spawner', 'Runner', 0);
  advance(engine, game, 90);
  engine.spawnEnemy(game, 'Spawner', 'Runner', 2);
  advance(engine, game, 210);
  assert.equal(game.coreHP, 97);
  assert.equal(game.scores.find(s => s.playerId === 'a').points, 15); // Money reward does not alter scoring.
  engine.repairCore(game, players[1]);
  const tower = game.towers[0]; engine.sellTower(game, players[1], tower.id);
  const paid = engine.economySummary(game);
  assert.deepEqual(paid.defenders.income, { passive: 50, bounties: 6, saleRefunds: 25 });
  assert.deepEqual(paid.defenders.spent, { towers: 50, upkeep: 1, repairs: 60 });
  assert.deepEqual(paid.spawner.income, { passive: 45, coreHits: 10 });
  assert.deepEqual(paid.spawner.spent, { enemies: 40 });
  reconciles(paid.defenders); reconciles(paid.spawner);
  const frozen = JSON.stringify(paid);
  assert.match(engine.sellTower(game, players[1], tower.id), /not found/);
  assert.match(engine.repairCore(game, players[1]), /full/);
  assert.equal(JSON.stringify(engine.economySummary(game)), frozen);
  assert.equal(C.economy.coreHitReward, 5);
});

test('early endings retain only elapsed samples and an actual final balance; later income is never invented', () => {
  const game = playing(); advance(G, game, 30 * 30);
  game.coreHP = 1; game.enemies.push({ id: 999, type: 'Tank', x: 600, y: 400, hp: 300, slows: [] });
  G.step(game);
  assert.equal(game.phase, 'finished'); assert.equal(game.winner, 'Spawner');
  const summary = G.economySummary(game);
  assert.deepEqual(summary.samples.map(s => s.seconds), [0, 30]);
  assert.ok(summary.defenders.finalBalance < 301);
  reconciles(summary.defenders); reconciles(summary.spawner);
});
