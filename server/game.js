const C = require('../shared/config');
const ticks = seconds => Math.round(seconds * C.network.tickHz);
function newGame() {
  return { phase: 'lobby', tick: 0, countdownTick: 0, matchTick: 0, n: 0,
    coreHP: C.match.coreHP, money: C.economy.spawnerStart, runnerReadyTick: 0,
    treasury: C.economy.defenderStart, treasuryError: 0, towers: [], spendFeed: [], nextSpendId: 1,
    warnings: [], enemies: [], nextEntityId: 1, reason: '' };
}
function start(game, players) {
  if (game.phase !== 'lobby') return 'A match has already started.';
  const connected = players.filter(p => p.connected);
  if (connected.length < C.room.minPlayers || !connected.some(p => p.role === 'Spawner') ||
      !connected.some(p => p.role === 'Defender')) return 'A connected Spawner and Defender are required.';
  game.phase = 'countdown'; game.countdownTick = 0;
  game.n = players.filter(p => p.role === 'Defender').length;
  game.treasury = C.economy.defenderStart + C.economy.defenderStartPerExtra * (game.n - 1);
  game.treasuryError = 0;
  return null;
}
function addTreasury(game, amount) {
  // Compensated summation keeps fractional tick income from becoming 49.999…
  // at the instant a 50-credit purchase should become affordable.
  const delta = amount - game.treasuryError;
  const next = game.treasury + delta;
  game.treasuryError = (next - game.treasury) - delta;
  game.treasury = next;
}
function placeShooter(game, player, snapId) {
  if (player.role !== 'Defender') return 'Only Defenders can place towers.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  if (!Number.isInteger(snapId) || !C.map.snapPoints[snapId]) return 'Invalid snap point.';
  if (game.towers.some(t => t.snapId === snapId)) return 'That snap point is occupied. Select another point.';
  const tower = C.towers.Shooter;
  if (game.treasury < tower.cost) return 'Not enough money in the Shared Treasury.';
  // Validation and purchase are synchronous: the first valid request owns the slot.
  addTreasury(game, -tower.cost);
  game.towers.push({ id: game.nextEntityId++, snapId, ...C.map.snapPoints[snapId], type: 'Shooter',
    ownerId: player.playerId, ownerName: player.nickname, readyTick: game.matchTick,
    kills: 0, damageDealt: 0, lastShot: null });
  game.spendFeed.push({ id: game.nextSpendId++, ownerId: player.playerId, nickname: player.nickname,
    towerType: 'Shooter', snapId, cost: tower.cost, matchTime: game.matchTick / C.network.tickHz });
  if (game.spendFeed.length > C.ui.spendFeedLimit) game.spendFeed.shift();
  return null;
}
function fireTowers(game) {
  for (const tower of game.towers) {
    if (game.matchTick < tower.readyTick) continue;
    const stats = C.towers[tower.type];
    let target = null, nearestCore = Infinity;
    for (const enemy of game.enemies) {
      if (Math.hypot(enemy.x - tower.x, enemy.y - tower.y) > stats.range) continue;
      const distance = Math.hypot(enemy.x - C.map.core.x, enemy.y - C.map.core.y);
      if (distance < nearestCore || (distance === nearestCore && enemy.id < target.id)) {
        target = enemy; nearestCore = distance;
      }
    }
    if (!target) continue;
    tower.readyTick = game.matchTick + ticks(1 / stats.rate);
    tower.lastShot = { tick: game.matchTick, targetId: target.id, x: target.x, y: target.y };
    const damage = Math.min(target.hp, stats.damage);
    target.hp -= damage; tower.damageDealt += damage;
    if (target.hp <= 0) {
      tower.kills++;
      addTreasury(game, C.enemies[target.type].bounty);
      game.enemies = game.enemies.filter(e => e.id !== target.id);
    }
  }
}
function spawnRunner(game, role, gateId) {
  if (role !== 'Spawner') return 'Only the Spawner can send Runners.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  if (!Number.isInteger(gateId) || !C.map.spawnGates[gateId]) return 'Invalid gate.';
  if (game.matchTick < game.runnerReadyTick) return 'Runner cooldown is not ready.';
  if (game.money < C.enemies.Runner.cost) return 'Not enough money.';
  if (game.enemies.length + game.warnings.length >= C.match.liveEnemyCap) return 'Enemy cap reached.';
  game.money -= C.enemies.Runner.cost;
  game.runnerReadyTick = game.matchTick + ticks(C.enemies.Runner.cooldown);
  game.warnings.push({ id: game.nextEntityId++, gateId, releaseTick: game.matchTick + ticks(C.spawnWarningSeconds) });
  return null;
}
function step(game) {
  game.tick++;
  if (game.phase === 'countdown') {
    game.countdownTick++;
    if (game.countdownTick >= ticks(C.match.countdownSeconds)) game.phase = 'playing';
    return;
  }
  if (game.phase !== 'playing') return;
  game.matchTick++;
  game.money += (C.economy.spawnerIncomeBase + C.economy.spawnerIncomePerDefender * game.n) / C.network.tickHz;
  addTreasury(game, C.economy.defenderIncome / C.network.tickHz);
  // A new Runner stays at its gate on the tick it appears.
  game.enemies = game.enemies.filter(enemy => {
    const dx = C.map.core.x - enemy.x, dy = C.map.core.y - enemy.y;
    const distance = Math.hypot(dx, dy), movement = C.enemies.Runner.speed / C.network.tickHz;
    if (distance <= movement) {
      game.coreHP = Math.max(0, game.coreHP - C.enemies.Runner.coreDamage);
      game.money += C.economy.coreHitReward;
      return false;
    }
    enemy.x += dx / distance * movement; enemy.y += dy / distance * movement;
    return true;
  });
  game.warnings = game.warnings.filter(warning => {
    if (game.matchTick < warning.releaseTick) return true;
    game.enemies.push({ id: warning.id, ...C.map.spawnGates[warning.gateId], type: 'Runner', hp: C.enemies.Runner.hp });
    return false;
  });
  if (game.coreHP > 0) fireTowers(game);
  if (game.coreHP <= 0 || game.matchTick >= ticks(C.match.durationSeconds)) {
    game.phase = 'finished';
    game.reason = game.coreHP <= 0 ? 'Spawner wins — the Core was destroyed.' : 'Defenders win — time expired.';
  }
}
function snapshot(game) {
  return { phase: game.phase, tick: game.tick, matchTime: game.matchTick / C.network.tickHz,
    countdown: Math.max(0, C.match.countdownSeconds - game.countdownTick / C.network.tickHz),
    remaining: Math.max(0, C.match.durationSeconds - game.matchTick / C.network.tickHz),
    coreHP: game.coreHP, money: game.money, treasury: game.treasury, n: game.n, reason: game.reason,
    runnerCooldown: Math.max(0, (game.runnerReadyTick - game.matchTick) / C.network.tickHz),
    warnings: game.warnings.map(w => ({ id: w.id, gateId: w.gateId, remaining: (w.releaseTick - game.matchTick) / C.network.tickHz })),
    enemies: game.enemies.map(e => ({ ...e })),
    towers: game.towers.map(t => ({ ...t, lastShot: t.lastShot && { ...t.lastShot } })),
    spendFeed: game.spendFeed.map(entry => ({ ...entry })) };
}
module.exports = { newGame, start, spawnRunner, placeShooter, step, snapshot };
