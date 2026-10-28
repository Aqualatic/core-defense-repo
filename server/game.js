const C = require('../shared/config');
const ticks = seconds => Math.round(seconds * C.network.tickHz);
function newGame() {
  return { phase: 'lobby', tick: 0, countdownTick: 0, matchTick: 0, n: 0,
    coreHP: C.match.coreHP, money: C.economy.spawnerStart, runnerReadyTick: 0,
    treasury: C.economy.defenderStart, treasuryError: 0, towers: [], scores: [], spendFeed: [], nextSpendId: 1,
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
function scoreFor(game, player) {
  let score = game.scores.find(s => s.playerId === player.playerId);
  if (!score) {
    score = { playerId: player.playerId, nickname: player.nickname, kills: 0, damage: 0, assists: 0, points: 0 };
    game.scores.push(score);
  }
  return score;
}
function spendEntry(game, player, tower, action, cost) {
  game.spendFeed.push({ id: game.nextSpendId++, ownerId: player.playerId, nickname: player.nickname,
    action, towerType: tower.type, snapId: tower.snapId, cost, matchTime: game.matchTick / C.network.tickHz });
  if (game.spendFeed.length > C.ui.spendFeedLimit) game.spendFeed.shift();
}
function placeTower(game, player, snapId, type = 'Shooter') {
  if (player.role !== 'Defender') return 'Only Defenders can place towers.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  if (typeof type !== 'string' || !Object.hasOwn(C.towers, type)) return 'Invalid tower type.';
  if (!Number.isInteger(snapId) || !C.map.snapPoints[snapId]) return 'Invalid snap point.';
  if (game.towers.some(t => t.snapId === snapId)) return 'That snap point is occupied. Select another point.';
  const stats = C.towers[type];
  if (game.treasury < stats.cost) return 'Not enough money in the Shared Treasury.';
  // Validation and purchase are synchronous: the first valid request owns the slot.
  addTreasury(game, -stats.cost);
  const tower = { id: game.nextEntityId++, snapId, ...C.map.snapPoints[snapId], type,
    ownerId: player.playerId, ownerName: player.nickname, readyTick: game.matchTick,
    placedTick: game.matchTick, costPaid: stats.cost, nextUpkeepTick: game.matchTick + ticks(C.upkeep.interval),
    disabled: false, kills: 0, damageDealt: 0, lastShot: null };
  game.towers.push(tower); scoreFor(game, player);
  spendEntry(game, player, tower, 'placed', stats.cost);
  return null;
}
const placeShooter = (game, player, snapId) => placeTower(game, player, snapId, 'Shooter');
function sellTower(game, player, towerId) {
  if (player.role !== 'Defender') return 'Only Defenders can sell towers.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  const tower = game.towers.find(t => t.id === towerId);
  if (!tower) return 'Tower not found.';
  if (tower.ownerId !== player.playerId) return 'Only the owner can sell this tower.';
  if (game.matchTick < tower.placedTick + ticks(C.selling.lockSeconds)) return 'Selling is locked for ' + C.selling.lockSeconds + ' second(s) after placement.';
  const refund = tower.costPaid * C.selling.refundFraction;
  game.towers = game.towers.filter(t => t.id !== towerId);
  addTreasury(game, refund);
  spendEntry(game, player, tower, 'sold', -refund);
  return null;
}
function payUpkeep(game) {
  for (const tower of game.towers) {
    if (game.matchTick < tower.nextUpkeepTick) continue;
    tower.nextUpkeepTick += ticks(C.upkeep.interval);
    tower.disabled = game.treasury < C.upkeep.cost;
    if (!tower.disabled) addTreasury(game, -C.upkeep.cost);
  }
}
function damageEnemy(game, tower, enemy, amount) {
  const score = scoreFor(game, { playerId: tower.ownerId, nickname: tower.ownerName });
  const damage = Math.min(enemy.hp, amount);
  enemy.hp -= damage; tower.damageDealt += damage;
  score.damage += damage; score.points += damage * C.scoring.damagePerHP;
  if (enemy.hp > 0) return;
  tower.kills++; score.kills++;
  score.points += C.scoring.killPoints[enemy.type];
  addTreasury(game, C.enemies[enemy.type].bounty);
  const active = (enemy.slows || []).filter(s => s.untilTick > game.matchTick);
  const strongest = Math.min(1, ...active.map(s => s.multiplier));
  const owners = new Set();
  for (const effect of active) {
    if (strongest >= 1 || effect.multiplier !== strongest || owners.has(effect.ownerId)) continue;
    owners.add(effect.ownerId);
    const assist = scoreFor(game, { playerId: effect.ownerId, nickname: effect.ownerName });
    assist.assists++; assist.points += C.scoring.freezerAssist;
  }
  game.enemies = game.enemies.filter(e => e.id !== enemy.id);
}
function fireTowers(game) {
  // Pulse slows first so same-tick assists do not depend on purchase order.
  const ordered = [...game.towers.filter(t => t.type === 'Freezer'), ...game.towers.filter(t => t.type !== 'Freezer')];
  for (const tower of ordered) {
    if (tower.disabled || game.matchTick < tower.readyTick) continue;
    const stats = C.towers[tower.type];
    const inRange = game.enemies.filter(e => Math.hypot(e.x - tower.x, e.y - tower.y) <= stats.range);
    if (!inRange.length) continue;
    tower.readyTick = game.matchTick + ticks(1 / stats.rate);
    if (tower.type === 'Freezer') {
      for (const enemy of inRange) {
        enemy.slows = (enemy.slows || []).filter(s => s.towerId !== tower.id);
        enemy.slows.push({ towerId: tower.id, ownerId: tower.ownerId, ownerName: tower.ownerName,
          multiplier: stats.slowMultiplier, untilTick: game.matchTick + ticks(stats.slowSeconds) });
      }
      tower.lastShot = { tick: game.matchTick, x: tower.x, y: tower.y };
      continue;
    }
    let target = null, nearestCore = Infinity;
    for (const enemy of inRange) {
      const distance = Math.hypot(enemy.x - C.map.core.x, enemy.y - C.map.core.y);
      if (distance < nearestCore || (distance === nearestCore && enemy.id < target.id)) {
        target = enemy; nearestCore = distance;
      }
    }
    tower.lastShot = { tick: game.matchTick, targetId: target.id, x: target.x, y: target.y };
    const targets = tower.type === 'Cannon'
      ? game.enemies.filter(e => Math.hypot(e.x - target.x, e.y - target.y) <= stats.splashRadius) : [target];
    for (const enemy of targets) damageEnemy(game, tower, enemy, stats.damage);
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
  payUpkeep(game);
  // A new Runner stays at its gate on the tick it appears.
  game.enemies = game.enemies.filter(enemy => {
    const dx = C.map.core.x - enemy.x, dy = C.map.core.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    // Movement covers the interval ending at this tick; an effect expiring now
    // still slows this last interval, but cannot grant an assist at its end.
    const multiplier = Math.min(1, ...(enemy.slows || []).filter(s => s.untilTick >= game.matchTick).map(s => s.multiplier));
    const movement = C.enemies.Runner.speed * multiplier / C.network.tickHz;
    enemy.slows = (enemy.slows || []).filter(s => s.untilTick > game.matchTick);
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
    game.enemies.push({ id: warning.id, ...C.map.spawnGates[warning.gateId], type: 'Runner', hp: C.enemies.Runner.hp, slows: [] });
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
    enemies: game.enemies.map(e => ({ ...e, slows: (e.slows || []).map(s => ({ ...s })) })),
    towers: game.towers.map(t => ({ ...t, lastShot: t.lastShot && { ...t.lastShot },
      sellLock: Math.max(0, (t.placedTick + ticks(C.selling.lockSeconds) - game.matchTick) / C.network.tickHz),
      sellRefund: t.costPaid * C.selling.refundFraction,
      upkeepIn: Math.max(0, (t.nextUpkeepTick - game.matchTick) / C.network.tickHz) })),
    scores: game.scores.map(s => ({ ...s })),
    spendFeed: game.spendFeed.map(entry => ({ ...entry })) };
}
module.exports = { newGame, start, spawnRunner, placeShooter, placeTower, sellTower, step, snapshot };
