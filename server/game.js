const defaultConfig = require('../shared/config');
// Live rooms and offline experiments use these same rules with isolated config.
function createEngine(C = defaultConfig) {
const ticks = seconds => Math.round(seconds * C.network.tickHz);
const moneyNumber = value => Number(value.toFixed(8));
function newLedger(treasury, money) {
  return { samples: [],
    defenders: { startingBalance: treasury, income: { passive: 0, bounties: 0, saleRefunds: 0 },
      spent: { towers: 0, upkeep: 0, repairs: 0 } },
    spawner: { startingBalance: money, income: { passive: 0, coreHits: 0 }, spent: { enemies: 0 } } };
}
function sampleMoney(game) {
  game.economyLog.samples.push({ seconds: game.matchTick / C.network.tickHz,
    treasury: moneyNumber(game.treasury), spawnerMoney: moneyNumber(game.money) });
}
function economySummary(game) {
  function side(ledger, finalBalance) {
    const income = Object.fromEntries(Object.entries(ledger.income).map(([k, v]) => [k, moneyNumber(v)]));
    const spent = Object.fromEntries(Object.entries(ledger.spent).map(([k, v]) => [k, moneyNumber(v)]));
    return { startingBalance: ledger.startingBalance, income, spent,
      totalIncome: moneyNumber(Object.values(income).reduce((a, b) => a + b, 0)),
      totalSpent: moneyNumber(Object.values(spent).reduce((a, b) => a + b, 0)),
      finalBalance: moneyNumber(finalBalance) };
  }
  return { settings: { upkeepSlope: C.upkeep.upkeepSlope, coreHitReward: C.economy.coreHitReward },
    sampleIntervalSeconds: C.diagnostics.moneySampleSeconds,
    samples: game.economyLog.samples.map(s => ({ ...s })),
    defenders: side(game.economyLog.defenders, game.treasury), spawner: side(game.economyLog.spawner, game.money) };
}
function upkeepPerTower(game) {
  return C.upkeep.cost * (1 + Math.max(0, game.towers.length - C.upkeep.scaleAfterTowers) * C.upkeep.upkeepSlope);
}
function newGame() {
  return { phase: 'lobby', tick: 0, countdownTick: 0, matchTick: 0, n: 0,
    coreHP: C.match.coreHP, money: C.economy.spawnerStart,
    spawnReadyTicks: Object.fromEntries(C.spawnTypes.map(type => [type, 0])), repairReadyTick: 0,
    participants: [], spawnerId: null, winner: null,
    cooldownTicks: { perType: Object.fromEntries(C.spawnTypes.map(type => [type, 0])), anyType: 0, allAffordable: 0 },
    treasury: C.economy.defenderStart, treasuryError: 0, towers: [], scores: [], spendFeed: [], nextSpendId: 1,
    economyLog: newLedger(C.economy.defenderStart, C.economy.spawnerStart),
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
  game.economyLog = newLedger(game.treasury, game.money);
  game.participants = players.filter(p => p.role !== 'Spectator' && p.playerId).map(p => p.playerId);
  game.spawnerId = players.find(p => p.role === 'Spawner')?.playerId;
  game.scores = [];
  players.filter(p => game.participants.includes(p.playerId)).forEach(p => scoreFor(game, p));
  return null;
}
function addTreasury(game, amount, category) {
  // Compensated summation keeps fractional tick income from becoming 49.999…
  // at the instant a 50-credit purchase should become affordable.
  const delta = amount - game.treasuryError;
  const next = game.treasury + delta;
  game.treasuryError = (next - game.treasury) - delta;
  game.treasury = next;
  const entries = Object.hasOwn(game.economyLog.defenders.income, category)
    ? game.economyLog.defenders.income : game.economyLog.defenders.spent;
  entries[category] += Math.abs(amount);
}
function scoreFor(game, player) {
  let score = game.scores.find(s => s.playerId === player.playerId);
  if (!score) {
    score = { playerId: player.playerId, nickname: player.nickname, role: player.role || 'Defender',
      kills: 0, damage: 0, assists: 0, coreDamage: 0, repairs: 0, winBonus: 0, points: 0 };
    game.scores.push(score);
  }
  return score;
}
function spendEntry(game, player, tower, action, cost, details = {}) {
  game.spendFeed.push({ id: game.nextSpendId++, ownerId: player.playerId, nickname: player.nickname,
    action, towerType: tower.type, snapId: tower.snapId, cost, matchTime: game.matchTick / C.network.tickHz, ...details });
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
  addTreasury(game, -stats.cost, 'towers');
  const tower = { id: game.nextEntityId++, snapId, ...C.map.snapPoints[snapId], type,
    ownerId: player.playerId, ownerName: player.nickname, readyTick: game.matchTick,
    placedTick: game.matchTick, costPaid: stats.cost, nextUpkeepTick: game.matchTick + ticks(C.upkeep.interval),
    disabled: false, kills: 0, damageDealt: 0, lastShot: null, assistAwardTicks: [] };
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
  addTreasury(game, refund, 'saleRefunds');
  spendEntry(game, player, tower, 'sold', -refund);
  return null;
}
function payUpkeep(game) {
  const bill = upkeepPerTower(game);
  for (const tower of game.towers) {
    if (game.matchTick < tower.nextUpkeepTick) continue;
    tower.nextUpkeepTick += ticks(C.upkeep.interval);
    const wasDisabled = tower.disabled;
    tower.disabled = game.treasury < bill;
    if (!tower.disabled) addTreasury(game, -bill, 'upkeep');
    if (wasDisabled !== tower.disabled) spendEntry(game, { playerId: tower.ownerId, nickname: tower.ownerName },
      tower, tower.disabled ? 'paused' : 'resumed', tower.disabled ? 0 : bill);
  }
}
function awardSlowApplication(game, tower, enemy) {
  // The enemy limit is global across all Freezers; the tower cap is a rolling window.
  tower.assistAwardTicks = tower.assistAwardTicks.filter(t => t > game.matchTick - ticks(C.scoring.assistTowerWindowSeconds));
  if (game.matchTick < (enemy.assistReadyTick || 0) ||
      (tower.assistAwardTicks.length + 1) * C.scoring.freezerAssist > C.scoring.assistTowerPointsPerWindow) return;
  tower.assistAwardTicks.push(game.matchTick);
  enemy.assistReadyTick = game.matchTick + ticks(C.scoring.assistEnemyCooldownSeconds);
  const score = scoreFor(game, { playerId: tower.ownerId, nickname: tower.ownerName });
  score.assists++; score.points += C.scoring.freezerAssist;
}
function makeEnemy(game, type, position, id = game.nextEntityId++) {
  return { id, type, x: position.x, y: position.y, hp: C.enemies[type].hp, slows: [], assistReadyTick: 0 };
}
function removeEnemy(game, enemy) {
  game.enemies = game.enemies.filter(e => e.id !== enemy.id);
}
function splitSwarm(game, enemy) {
  removeEnemy(game, enemy);
  // The parent's five reserved slots become five Tinies; none can be dropped.
  for (let i = 0; i < C.enemies.Swarm.splitCount; i++) game.enemies.push(makeEnemy(game, 'Tiny', enemy));
}
function damageEnemy(game, tower, enemy, amount) {
  const score = scoreFor(game, { playerId: tower.ownerId, nickname: tower.ownerName });
  const damage = Math.min(enemy.hp, amount);
  enemy.hp -= damage; tower.damageDealt += damage;
  score.damage += damage; score.points += damage * C.scoring.damagePerHP;
  if (enemy.hp > 0) return;
  tower.kills++; score.kills++;
  score.points += C.scoring.killPoints[enemy.type];
  addTreasury(game, C.enemies[enemy.type].bounty, 'bounties');
  if (enemy.type === 'Swarm') splitSwarm(game, enemy);
  else removeEnemy(game, enemy);
}
function fireTowers(game) {
  // Apply pulses before damage. Simultaneous assist claims use placement order.
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
        awardSlowApplication(game, tower, enemy);
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
const slotsFor = type => C.enemies[type]?.splitCount || 1;
function enemySlots(game) {
  const active = game.enemies.reduce((sum, e) => sum + slotsFor(e.type), 0);
  const pending = game.warnings.reduce((sum, w) => sum + slotsFor(w.type), 0);
  return { used: active + pending, active, pending, cap: C.match.liveEnemyCap };
}
function spawnStatus(game, type) {
  const cooldown = Math.max(0, (game.spawnReadyTicks[type] - game.matchTick) / C.network.tickHz);
  const moneyBlocked = game.money < C.enemies[type].cost;
  const capBlocked = enemySlots(game).used + slotsFor(type) > C.match.liveEnemyCap;
  return { cooldown, moneyBlocked, capBlocked, ready: game.phase === 'playing' && !moneyBlocked && !capBlocked && cooldown <= 0 };
}
function spawnEnemy(game, role, type, gateId) {
  if (role !== 'Spawner') return 'Only the Spawner can send enemies.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  if (!C.spawnTypes.includes(type)) return 'Invalid enemy type.';
  if (!Number.isInteger(gateId) || !C.map.spawnGates[gateId]) return 'Invalid gate.';
  const status = spawnStatus(game, type), stats = C.enemies[type];
  if (status.cooldown > 0) return type + ' cooldown is not ready.';
  if (status.moneyBlocked) return 'Not enough money.';
  if (status.capBlocked) return 'Enemy cap reached: ' + type + ' needs ' + slotsFor(type) + ' slots.';
  game.money -= stats.cost;
  game.economyLog.spawner.spent.enemies += stats.cost;
  game.spawnReadyTicks[type] = game.matchTick + ticks(stats.cooldown);
  game.warnings.push({ id: game.nextEntityId++, type, gateId, releaseTick: game.matchTick + ticks(C.spawnWarningSeconds) });
  return null;
}
const spawnRunner = (game, role, gateId) => spawnEnemy(game, role, 'Runner', gateId);
function repairCore(game, player) {
  if (player.role !== 'Defender') return 'Only Defenders can repair the Core.';
  if (game.phase !== 'playing') return 'Wait for the match to begin.';
  if (game.coreHP >= C.match.coreHP) return 'The Core is already at full HP.';
  if (game.matchTick < game.repairReadyTick) return 'Core Repair cooldown is not ready.';
  if (game.treasury < C.repair.cost) return 'Not enough money in the Shared Treasury.';
  const healed = Math.min(C.repair.heal, C.match.coreHP - game.coreHP);
  game.coreHP += healed; addTreasury(game, -C.repair.cost, 'repairs');
  game.repairReadyTick = game.matchTick + ticks(C.repair.cooldown);
  const score = scoreFor(game, player); score.repairs++; score.points += C.scoring.repair;
  spendEntry(game, player, { type: 'Core', snapId: null }, 'repaired', C.repair.cost, { healed });
  return null;
}
function recordCooldownTime(game) {
  const statuses = C.spawnTypes.map(type => ({ type, ...spawnStatus(game, type) }));
  const affordable = statuses.filter(s => !s.moneyBlocked);
  const blocked = affordable.filter(s => !s.capBlocked && s.cooldown > 0);
  blocked.forEach(s => game.cooldownTicks.perType[s.type]++);
  if (blocked.length) game.cooldownTicks.anyType++;
  if (affordable.length && affordable.every(s => !s.capBlocked && s.cooldown > 0)) game.cooldownTicks.allAffordable++;
}
function spawnDiagnostics(game) {
  return { perTypeSeconds: Object.fromEntries(C.spawnTypes.map(type => [type, game.cooldownTicks.perType[type] / C.network.tickHz])),
    anyTypeSeconds: game.cooldownTicks.anyType / C.network.tickHz,
    allAffordableSeconds: game.cooldownTicks.allAffordable / C.network.tickHz };
}
function finish(game) {
  game.phase = 'finished'; game.winner = game.coreHP <= 0 ? 'Spawner' : 'Defender';
  game.reason = game.winner === 'Spawner' ? 'Spawner wins — the Core was destroyed.' : 'Defenders win — time expired.';
  for (const score of game.scores) {
    if (game.participants.includes(score.playerId) && score.role === game.winner) {
      score.winBonus = C.scoring.winBonus; score.points += C.scoring.winBonus;
    }
  }
}
function step(game) {
  game.tick++;
  if (game.phase === 'countdown') {
    game.countdownTick++;
    if (game.countdownTick >= ticks(C.match.countdownSeconds)) { game.phase = 'playing'; sampleMoney(game); }
    return;
  }
  if (game.phase !== 'playing') return;
  // Sample the interval beginning now, before advancing the tick/cooldown clock.
  recordCooldownTime(game);
  game.matchTick++;
  const spawnerIncome = (C.economy.spawnerIncomeBase + C.economy.spawnerIncomePerDefender * game.n) / C.network.tickHz;
  game.money += spawnerIncome;
  game.economyLog.spawner.income.passive += spawnerIncome;
  addTreasury(game, C.economy.defenderIncome / C.network.tickHz, 'passive');
  payUpkeep(game);
  // A new Runner stays at its gate on the tick it appears.
  for (const enemy of [...game.enemies]) {
    if (game.coreHP <= 0) break;
    const dx = C.map.core.x - enemy.x, dy = C.map.core.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    // Movement covers the interval ending at this tick; an effect expiring now
    // still slows this last interval. Assist points are awarded only by pulses.
    const multiplier = Math.min(1, ...(enemy.slows || []).filter(s => s.untilTick >= game.matchTick).map(s => s.multiplier));
    const stats = C.enemies[enemy.type], movement = stats.speed * multiplier / C.network.tickHz;
    enemy.slows = (enemy.slows || []).filter(s => s.untilTick > game.matchTick);
    if (distance > 0) {
      const travel = Math.min(distance, movement);
      enemy.x += dx / distance * travel; enemy.y += dy / distance * travel;
    }
    if (enemy.type === 'Swarm' && Math.hypot(enemy.x - C.map.core.x, enemy.y - C.map.core.y) <= stats.splitDistance) {
      splitSwarm(game, enemy);
    } else if (distance <= movement) {
      const damage = Math.min(game.coreHP, stats.coreDamage);
      game.coreHP -= damage;
      game.money += C.economy.coreHitReward;
      game.economyLog.spawner.income.coreHits += C.economy.coreHitReward;
      const score = game.scores.find(s => s.playerId === game.spawnerId);
      if (score) { score.coreDamage += damage; score.points += damage * C.scoring.coreDamagePerHP; }
      removeEnemy(game, enemy);
    }
  }
  game.warnings = game.warnings.filter(warning => {
    if (game.matchTick < warning.releaseTick) return true;
    game.enemies.push(makeEnemy(game, warning.type, C.map.spawnGates[warning.gateId], warning.id));
    return false;
  });
  if (game.coreHP > 0) fireTowers(game);
  if (game.coreHP <= 0 || game.matchTick >= ticks(C.match.durationSeconds)) {
    finish(game);
  }
  if (game.matchTick % ticks(C.diagnostics.moneySampleSeconds) === 0) sampleMoney(game);
}
function snapshot(game) {
  return { phase: game.phase, tick: game.tick, matchTime: game.matchTick / C.network.tickHz,
    countdown: Math.max(0, C.match.countdownSeconds - game.countdownTick / C.network.tickHz),
    remaining: Math.max(0, C.match.durationSeconds - game.matchTick / C.network.tickHz),
    coreHP: game.coreHP, money: game.money, treasury: game.treasury, n: game.n, reason: game.reason,
    upkeepPerTower: upkeepPerTower(game),
    runnerCooldown: spawnStatus(game, 'Runner').cooldown,
    spawns: Object.fromEntries(C.spawnTypes.map(type => [type, spawnStatus(game, type)])),
    spawnDiagnostics: spawnDiagnostics(game), enemySlots: enemySlots(game), winner: game.winner,
    repairCooldown: Math.max(0, (game.repairReadyTick - game.matchTick) / C.network.tickHz),
    warnings: game.warnings.map(w => ({ id: w.id, type: w.type, gateId: w.gateId, remaining: (w.releaseTick - game.matchTick) / C.network.tickHz })),
    enemies: game.enemies.map(e => ({ ...e, slows: (e.slows || []).map(s => ({ ...s })) })),
    towers: game.towers.map(t => ({ ...t, lastShot: t.lastShot && { ...t.lastShot },
      sellLock: Math.max(0, (t.placedTick + ticks(C.selling.lockSeconds) - game.matchTick) / C.network.tickHz),
      sellRefund: t.costPaid * C.selling.refundFraction,
      upkeepIn: Math.max(0, (t.nextUpkeepTick - game.matchTick) / C.network.tickHz) })),
    scores: game.scores.map(s => ({ ...s })),
    spendFeed: game.spendFeed.map(entry => ({ ...entry })) };
}
return { newGame, start, spawnRunner, spawnEnemy, placeShooter, placeTower, sellTower, repairCore,
  enemySlots, spawnStatus, spawnDiagnostics, economySummary, step, snapshot };
}
module.exports = { ...createEngine(), createEngine };
