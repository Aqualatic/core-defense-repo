const C = require('./shared/config');
const { createEngine } = require('./server/game');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SPAWNERS = ['runner-spam', 'swarm-rush', 'mixed', 'weakest-gate', 'human-like'];
const DEFENDERS = ['spread', 'clustered', 'lazy'];
const SETTINGS = {
  current: { upkeepSlope: C.upkeep.upkeepSlope, coreHitReward: C.economy.coreHitReward },
  upkeepSlope0125: { upkeepSlope: 0.125, coreHitReward: C.economy.coreHitReward },
  coreHitReward10: { upkeepSlope: C.upkeep.upkeepSlope, coreHitReward: 10 }
};
const DECISION_HZ = 10; // Bot reaction cadence, not the simulation tick rate.
const spreadOrder = [0, 8, 4, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15];
function hashSeed(...parts) {
  let hash = 2166136261 >>> 0;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function experimentConfig({ upkeepSlope = C.upkeep.upkeepSlope, coreHitReward = C.economy.coreHitReward } = {}) {
  if (![upkeepSlope, coreHitReward].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Experiment values must be finite nonnegative numbers.');
  }
  const config = structuredClone(C);
  config.upkeep.upkeepSlope = upkeepSlope; config.economy.coreHitReward = coreHitReward;
  return config;
}
function oppositeGate(gate, config = C) {
  const a = config.map.spawnGates[gate], core = config.map.core;
  const opposite = { x: 2 * core.x - a.x, y: 2 * core.y - a.y };
  let best = 0, distance = Infinity;
  config.map.spawnGates.forEach((p, i) => {
    const d = Math.hypot(p.x - opposite.x, p.y - opposite.y);
    if (d < distance) { distance = d; best = i; }
  });
  return best;
}
function roster(n) {
  return [{ playerId: 'spawner', nickname: 'Spawner', role: 'Spawner', connected: true },
    ...Array.from({ length: n }, (_, i) => ({ playerId: 'defender-' + i, nickname: 'Defender ' + (i + 1), role: 'Defender', connected: true }))];
}
function simulate({ n, spawnerStrategy = 'human-like', defenderStrategy = 'spread', seed = 1,
  config = C, trace = false } = {}) {
  if (!Number.isInteger(n) || n < 1 || n >= config.room.maxPlayers) throw new Error('Invalid Defender count.');
  if (!SPAWNERS.includes(spawnerStrategy) || !DEFENDERS.includes(defenderStrategy)) throw new Error('Invalid strategy.');
  const engine = createEngine(config), game = engine.newGame(), players = roster(n);
  const random = mulberry32(hashSeed(seed, n, spawnerStrategy, defenderStrategy));
  // Exclude experiment settings from the seed: each setting receives paired seeds.
  const primaryGate = Math.floor(random() * config.map.spawnGates.length);
  let previousGate = primaryGate;
  const maxTowers = defenderStrategy === 'lazy' ? 6 : config.map.snapPoints.length;
  const towerOrder = defenderStrategy === 'clustered' ? config.map.snapPoints.map((_, i) => i) : spreadOrder;
  const actions = trace ? [] : null;
  const buckets = new Map();
  function allow(player, event) {
    // The socket transport rate-limits requests outside the game engine. Mirror
    // those limits for bots; never bypass them with an unrealistic action burst.
    const limits = { spawn: config.network.spawnRequestsPerSecond, place: config.network.placementRequestsPerSecond,
      repair: config.network.repairRequestsPerSecond, general: config.network.generalRequestsPerSecond };
    const windowTicks = config.network.rateWindowMs / 1000 * config.network.tickHz;
    const take = (key, limit) => {
      const bucket = (buckets.get(key) || []).filter(t => t > game.matchTick - windowTicks);
      buckets.set(key, bucket);
      if (bucket.length >= limit) return false;
      bucket.push(game.matchTick); return true;
    };
    return take(player.playerId + ':general', limits.general) && take(player.playerId + ':' + event, limits[event]);
  }
  function act(player, type, payload) {
    if (!allow(player, type)) return false;
    const error = type === 'spawn' ? engine.spawnEnemy(game, player.role, payload.type, payload.gateId)
      : type === 'place' ? engine.placeTower(game, player, payload.snapId, payload.type) : engine.repairCore(game, player);
    if (error) return false;
    if (actions) actions.push({ tick: game.matchTick, playerId: player.playerId, type, payload: { ...payload } });
    return true;
  }
  function weakestGate() {
    const strengths = config.map.spawnGates.map(gate => {
      const dx = gate.x - config.map.core.x, dy = gate.y - config.map.core.y, length = Math.hypot(dx, dy);
      const crossing = { x: config.map.core.x + dx / length * config.map.ringRadius,
        y: config.map.core.y + dy / length * config.map.ringRadius };
      return game.towers.reduce((sum, tower) => sum + (!tower.disabled &&
        Math.hypot(tower.x - crossing.x, tower.y - crossing.y) <= config.towers[tower.type].range
        ? tower.type === 'Cannon' ? 2 : 1 : 0), 0);
    });
    const minimum = Math.min(...strengths), candidates = strengths.flatMap((s, i) => s === minimum ? [i] : []);
    return candidates[Math.floor(random() * candidates.length)];
  }
  function chooseGate(type) {
    if (spawnerStrategy === 'runner-spam') return Math.floor(random() * config.map.spawnGates.length);
    if (spawnerStrategy === 'swarm-rush') return primaryGate;
    if (spawnerStrategy === 'mixed') return type === 'Runner' ? oppositeGate(primaryGate, config) : primaryGate;
    if (spawnerStrategy === 'human-like') {
      previousGate = random() < 0.65 ? previousGate : Math.floor(random() * config.map.spawnGates.length);
      return previousGate;
    }
    return weakestGate();
  }
  function spawn() {
    const priority = spawnerStrategy === 'runner-spam' ? ['Runner'] : spawnerStrategy === 'swarm-rush' ? ['Swarm']
      : spawnerStrategy === 'mixed' ? ['Tank', 'Runner'] : ['Tank', 'Swarm', 'Runner'];
    // At most one accepted spawn per type at a decision; engine cooldowns apply.
    for (const type of priority) {
      if (engine.spawnStatus(game, type).ready) act(players[0], 'spawn', { type, gateId: chooseGate(type) });
    }
  }
  function defend() {
    // Retain the prior purchase policy: buy missing Cannon/Shooter/Freezer when
    // affordable, otherwise Shooter; do not save specifically for a Freezer.
    while (game.towers.length < maxTowers) {
      let type;
      for (const candidate of ['Cannon', 'Shooter', 'Freezer']) {
        if (!game.towers.some(t => t.type === candidate) && game.treasury >= config.towers[candidate].cost) {
          type = candidate; break;
        }
      }
      if (!type && game.treasury >= config.towers.Shooter.cost) type = 'Shooter';
      if (!type || !act(players[1], 'place', { type, snapId: towerOrder[game.towers.length] })) break;
    }
    if (game.phase === 'playing' && game.coreHP < config.match.coreHP && game.treasury >= config.repair.cost &&
        game.matchTick >= game.repairReadyTick) act(players[1], 'repair', {});
  }
  engine.start(game, players);
  while (game.phase === 'countdown') engine.step(game);
  const decisionTicks = config.network.tickHz / DECISION_HZ;
  if (!Number.isInteger(decisionTicks)) throw new Error('Bot decision cadence must divide tickHz.');
  while (game.phase === 'playing') {
    if (game.matchTick % decisionTicks === 0) { spawn(); defend(); }
    engine.step(game); // The only movement/combat/economy/win implementation.
  }
  const reachedTimeLimit = game.matchTick === config.match.durationSeconds * config.network.tickHz;
  return { n, spawnerStrategy, defenderStrategy, seed, winner: game.winner,
    elapsedSeconds: game.matchTick / config.network.tickHz, reachedTimeLimit,
    coreHP: game.coreHP, treasuryAtFiveMinutes: reachedTimeLimit ? game.treasury : null,
    economy: engine.economySummary(game), cooldowns: engine.spawnDiagnostics(game), ...(actions ? { actions } : {}) };
}
function summarize(matches) {
  const mean = (rows, select) => rows.length ? Number((rows.reduce((sum, r) => sum + select(r), 0) / rows.length).toFixed(2)) : null;
  function group(rows) {
    return { count: rows.length, meanTreasury: mean(rows, r => r.economy.defenders.finalBalance),
      meanSpawnerMoney: mean(rows, r => r.economy.spawner.finalBalance), meanCoreHP: mean(rows, r => r.coreHP),
      meanEndSeconds: mean(rows, r => r.elapsedSeconds) };
  }
  return { runs: matches.length, defenderWinRate: matches.filter(m => m.winner === 'Defender').length / matches.length,
    atFiveMinutes: group(matches.filter(m => m.reachedTimeLimit)), earlyEndings: group(matches.filter(m => !m.reachedTimeLimit)) };
}
function runGrid({ runs = 50, settings = Object.keys(SETTINGS), spawners = SPAWNERS, defenders = ['spread'], ns = [1,3,7] } = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer.');
  const results = [], matches = [];
  for (const setting of settings) {
    if (!Object.hasOwn(SETTINGS, setting)) throw new Error('Invalid setting: ' + setting);
    const config = experimentConfig(SETTINGS[setting]);
    for (const spawnerStrategy of spawners) for (const defenderStrategy of defenders) for (const n of ns) {
      const group = Array.from({ length: runs }, (_, run) => ({ setting,
        ...simulate({ n, spawnerStrategy, defenderStrategy, config, seed: 100000 + n * 10000 + run * 7919 }) }));
      results.push({ setting, spawnerStrategy, defenderStrategy, n, ...summarize(group) }); matches.push(...group);
    }
  }
  const digest = file => createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex');
  return { metadata: { engine: 'server/game.js', tickHz: C.network.tickHz, botDecisionHz: DECISION_HZ, runsPerCombination: runs,
    settings: Object.fromEntries(settings.map(s => [s, SETTINGS[s]])), spawners, defenders, ns,
    seedFormula: '100000 + N * 10000 + runIndex * 7919; hash(seed,N,spawnerStrategy,defenderStrategy), mulberry32',
    sourceHashes: { engine: digest('server/game.js'), config: digest('shared/config.js'), simulator: digest('balance_sim.js') },
    notes: 'Paired seeds across settings. No Surge: absent in current playable engine. 5:00 means elapsedSeconds=300, not all final balances. One scripted team controller; this is not human playtest data.' },
    results, matches };
}
function main(args) {
  const options = {};
  for (const arg of args) {
    const [key, value, extra] = arg.split('=');
    if (!value || extra !== undefined) throw new Error('Use --runs=50, --settings=current, --spawners=human-like, --defenders=spread, --ns=1,3,7.');
    if (key === '--runs') options.runs = Number(value);
    else if (['--settings','--spawners','--defenders'].includes(key)) options[key.slice(2)] = value.split(',');
    else if (key === '--ns') options.ns = value.split(',').map(Number);
    else throw new Error('Unknown option: ' + key);
  }
  console.log(JSON.stringify(runGrid(options), null, 2));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { simulate, summarize, runGrid, experimentConfig, oppositeGate, roster, SETTINGS, SPAWNERS, DEFENDERS };
