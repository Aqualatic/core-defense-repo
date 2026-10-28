const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const { createEngine } = require('../server/game');
const { simulate, summarize, experimentConfig, oppositeGate, roster, runGrid } = require('../balance_sim');

test('mixed strategy sends Runners to the geometrically opposite gate for all eight gates', () => {
  assert.deepEqual(C.map.spawnGates.map((_, i) => oppositeGate(i)), [2,3,0,1,6,7,4,5]);
  const result = simulate({ n: 1, seed: 123, spawnerStrategy: 'mixed', trace: true });
  const tank = result.actions.find(a => a.type === 'spawn' && a.payload.type === 'Tank');
  const runner = result.actions.find(a => a.type === 'spawn' && a.payload.type === 'Runner');
  assert.equal(runner.payload.gateId, oppositeGate(tank.payload.gateId));
});

test('simulated action traces replay exactly through the playable engine for all experiment settings', () => {
  for (const overrides of [{}, { upkeepSlope: 0.125 }, { coreHitReward: 10 }]) {
    const config = experimentConfig(overrides), n = 3;
    const result = simulate({ n, config, seed: 173352, trace: true });
    const engine = createEngine(config), game = engine.newGame(), players = roster(n);
    engine.start(game, players);
    while (game.phase === 'countdown') engine.step(game);
    let actionIndex = 0;
    while (game.phase === 'playing') {
      while (result.actions[actionIndex]?.tick === game.matchTick) {
        const action = result.actions[actionIndex++], player = players.find(p => p.playerId === action.playerId);
        const error = action.type === 'spawn' ? engine.spawnEnemy(game, player.role, action.payload.type, action.payload.gateId)
          : action.type === 'place' ? engine.placeTower(game, player, action.payload.snapId, action.payload.type)
          : engine.repairCore(game, player);
        assert.equal(error, null);
      }
      engine.step(game);
    }
    assert.equal(actionIndex, result.actions.length);
    assert.equal(game.winner, result.winner); assert.equal(game.coreHP, result.coreHP);
    assert.deepEqual(engine.economySummary(game), result.economy);
    for (const side of ['defenders', 'spawner']) {
      const book = result.economy[side];
      assert.ok(Math.abs(book.startingBalance + book.totalIncome - book.totalSpent - book.finalBalance) < 1e-6);
    }
  }
});

test('simulation is deterministic, uses paired seeds and leaves live defaults untouched', () => {
  const before = JSON.stringify(C);
  const report = runGrid({ runs: 2, spawners: ['human-like'], ns: [1] });
  assert.equal(report.matches.length, 6);
  assert.deepEqual(report.matches.slice(0,2).map(m => m.seed), report.matches.slice(2,4).map(m => m.seed));
  assert.deepEqual(report.matches.slice(0,2).map(m => m.seed), report.matches.slice(4,6).map(m => m.seed));
  const a = simulate({ n: 1, seed: 71, spawnerStrategy: 'swarm-rush' });
  const b = simulate({ n: 1, seed: 71, spawnerStrategy: 'swarm-rush' });
  assert.deepEqual(a, b); assert.equal(JSON.stringify(C), before);
  assert.equal(report.metadata.engine, 'server/game.js');
  assert.throws(() => experimentConfig({ upkeepSlope: -1 }), /nonnegative/);
});

test('aggregation separates early balances from 5:00 and counts a deadline loss at 5:00', () => {
  const match = (seconds, treasury, winner) => ({ elapsedSeconds: seconds, reachedTimeLimit: seconds === 300,
    winner, coreHP: winner === 'Defender' ? 100 : 0,
    economy: { defenders: { finalBalance: treasury }, spawner: { finalBalance: 7 } } });
  const result = summarize([match(60, 10, 'Spawner'), match(300, 500, 'Defender'), match(300, 100, 'Spawner')]);
  assert.equal(result.atFiveMinutes.count, 2); assert.equal(result.atFiveMinutes.meanTreasury, 300);
  assert.equal(result.earlyEndings.count, 1); assert.equal(result.earlyEndings.meanTreasury, 10);
  assert.equal(result.earlyEndings.meanEndSeconds, 60); assert.equal(result.defenderWinRate, 1/3);
  const none = summarize([match(60, 10, 'Spawner')]);
  assert.equal(none.atFiveMinutes.meanTreasury, null); assert.equal(none.atFiveMinutes.count, 0);
});
