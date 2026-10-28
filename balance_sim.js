const C = require('./shared/config');
const DT = 0.1; // Analytical simulator resolution; the live server uses config.network.tickHz.
const MATCH = C.match.durationSeconds;
const CORE_MAX = Number(process.env.CORE_HP || C.match.coreHP);
const CENTER = C.map.core;
const RING = C.map.ringRadius;
const WARNING = Number(process.env.SPAWN_WARNING || C.spawnWarningSeconds);
const LIVE_CAP = C.match.liveEnemyCap;
const GATES = C.map.spawnGates;
const SNAP_POINTS = C.map.snapPoints;

const BASE_CONFIG = {
  defenderStart: n => C.economy.defenderStart + C.economy.defenderStartPerExtra * (n - 1),
  defenderIncome: C.economy.defenderIncome,
  spawnerStart: C.economy.spawnerStart,
  spawnerIncome: n => Number(process.env.SPAWNER_BASE || C.economy.spawnerIncomeBase) + Number(process.env.SPAWNER_PER_DEF || C.economy.spawnerIncomePerDefender) * n,
  upkeep: C.upkeep.cost,
  repairCost: C.repair.cost,
  repairHeal: C.repair.heal,
  repairCooldown: C.repair.cooldown,
  enemies: {
    Runner: C.enemies.Runner,
    Tank: C.enemies.Tank,
    Swarm: { ...C.enemies.Swarm, cost: Number(process.env.SWARM_COST || C.enemies.Swarm.cost), cooldown: Number(process.env.SWARM_CD || C.enemies.Swarm.cooldown) },
    Tiny: { ...C.enemies.Tiny, coreDamage: Number(process.env.TINY_CORE_DAMAGE || C.enemies.Tiny.coreDamage) }
  },
  towers: {
    Shooter: C.towers.Shooter,
    Cannon: C.towers.Cannon,
    Freezer: C.towers.Freezer
  }
};

function hashSeed(...parts) {
  let hash = 2166136261 >>> 0;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function pathPointAtRadius(gate, radius) {
  const dx = CENTER.x - gate.x;
  const dy = CENTER.y - gate.y;
  const length = Math.hypot(dx, dy);
  return { x: CENTER.x - dx / length * radius, y: CENTER.y - dy / length * radius };
}

function simulate({ n, spawnerStrategy, defenderStrategy, seed, config = BASE_CONFIG }) {
  const random = mulberry32(hashSeed(seed, n, spawnerStrategy, defenderStrategy));
  const maxTowers = defenderStrategy === 'lazy' ? 6 : 16;
  const defenderStart = config.defenderStart(n);
  let time = 0;
  let core = CORE_MAX;
  let defenderMoney = defenderStart;
  let spawnerMoney = config.spawnerStart;
  let nextId = 1;
  let winner = null;
  let enemies = [];
  let warnings = [];
  let towers = [];
  let cooldowns = { Runner: 0, Tank: 0, Swarm: 0 };
  let surgeRemaining = 0;
  let surgeReadyAt = 45;
  let repairReadyAt = 0;
  const swarmGate = Math.floor(random() * 8);
  let previousGate = swarmGate;
  const spreadOrder = [0, 8, 4, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15];
  const towerOrder = defenderStrategy === 'clustered' ? Array.from({ length: 16 }, (_, i) => i) : spreadOrder;

  function chooseWeakestGate() {
    const scores = [];
    for (let gateIndex = 0; gateIndex < GATES.length; gateIndex++) {
      const crossing = pathPointAtRadius(GATES[gateIndex], RING);
      let score = 0;
      for (const tower of towers) {
        if (distance(tower, crossing) <= config.towers[tower.kind].range) {
          score += tower.kind === 'Cannon' ? 2 : 1;
        }
      }
      scores.push(score);
    }
    const minimum = Math.min(...scores);
    const candidates = scores.map((score, i) => score === minimum ? i : -1).filter(i => i >= 0);
    return candidates[Math.floor(random() * candidates.length)];
  }

  function chooseGate(type) {
    if (spawnerStrategy === 'runner-spam') return Math.floor(random() * 8);
    if (spawnerStrategy === 'swarm-rush') return swarmGate;
    if (spawnerStrategy === 'mixed') return type === 'Runner' ? (swarmGate + 4) % 8 : swarmGate;
    if (spawnerStrategy === 'human-like') {
      const gate = random() < 0.65 ? previousGate : Math.floor(random() * 8);
      previousGate = gate;
      return gate;
    }
    return chooseWeakestGate();
  }

  function placeTower(kind) {
    const spec = config.towers[kind];
    if (towers.length >= maxTowers || defenderMoney < spec.cost) return false;
    const position = SNAP_POINTS[towerOrder[towers.length]];
    defenderMoney -= spec.cost;
    towers.push({
      kind,
      x: position.x,
      y: position.y,
      nextFireAt: time,
      nextUpkeepAt: time + 10,
      disabled: false
    });
    return true;
  }

  function buildDefenderTowers() {
    while (towers.length < maxTowers) {
      let kind = null;
      if (!towers.some(t => t.kind === 'Cannon') && defenderMoney >= config.towers.Cannon.cost) kind = 'Cannon';
      else if (!towers.some(t => t.kind === 'Shooter') && defenderMoney >= config.towers.Shooter.cost) kind = 'Shooter';
      else if (!towers.some(t => t.kind === 'Freezer') && defenderMoney >= config.towers.Freezer.cost) kind = 'Freezer';
      else if (defenderMoney >= config.towers.Shooter.cost) kind = 'Shooter';
      else break;
      if (!placeTower(kind)) break;
    }
  }

  function activateSurge() {
    if (time >= surgeReadyAt && surgeRemaining === 0) {
      surgeRemaining = 3;
      surgeReadyAt = time + 45;
      return true;
    }
    return false;
  }

  function clickSpawn(type) {
    const spec = config.enemies[type];
    if (spawnerMoney < spec.cost || time < cooldowns[type]) return false;
    if (enemies.length + warnings.length >= LIVE_CAP) return false;
    const surged = surgeRemaining > 0;
    spawnerMoney -= spec.cost;
    cooldowns[type] = time + spec.cooldown;
    if (surged) surgeRemaining--;
    warnings.push({ type, gate: chooseGate(type), appearsAt: time + WARNING, surged });
    return true;
  }

  function spawnerAct() {
    if (time === 45) activateSurge();
    if (spawnerStrategy === 'swarm-rush' && time >= 45 && surgeRemaining === 0) activateSurge();

    for (let i = 0; i < 4; i++) {
      let type = null;
      if (spawnerStrategy === 'runner-spam') {
        if (spawnerMoney >= 20 && time >= cooldowns.Runner) type = 'Runner';
      } else if (spawnerStrategy === 'swarm-rush') {
        if (spawnerMoney >= 60 && time >= cooldowns.Swarm) type = 'Swarm';
      } else if (spawnerStrategy === 'mixed') {
        if (spawnerMoney >= 80 && time >= cooldowns.Tank) type = 'Tank';
        else if (spawnerMoney >= 20 && time >= cooldowns.Runner) type = 'Runner';
      } else if (spawnerStrategy === 'human-like') {
        if (spawnerMoney >= 80 && time >= cooldowns.Tank) type = 'Tank';
        else if (spawnerMoney >= 60 && time >= cooldowns.Swarm) type = 'Swarm';
        else if (spawnerMoney >= 20 && time >= cooldowns.Runner) type = 'Runner';
      } else {
        if (spawnerMoney >= 80 && time >= cooldowns.Tank) type = 'Tank';
        else if (spawnerMoney >= 60 && time >= cooldowns.Swarm) type = 'Swarm';
        else if (spawnerMoney >= 20 && time >= cooldowns.Runner) type = 'Runner';
      }
      if (!type || !clickSpawn(type)) break;
    }
  }

  function releaseWarnings() {
    for (let i = warnings.length - 1; i >= 0; i--) {
      const warning = warnings[i];
      if (time < warning.appearsAt) continue;
      const spec = config.enemies[warning.type];
      const gate = GATES[warning.gate];
      enemies.push({
        id: nextId++,
        type: warning.type,
        hp: spec.hp,
        x: gate.x,
        y: gate.y,
        baseSpeed: spec.speed,
        speedMultiplier: warning.surged ? 1.25 : 1,
        coreDamage: spec.coreDamage,
        bounty: spec.bounty,
        slowUntil: 0
      });
      warnings.splice(i, 1);
    }
  }

  function moveEnemies() {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const enemy = enemies[i];
      const dx = CENTER.x - enemy.x;
      const dy = CENTER.y - enemy.y;
      const length = Math.hypot(dx, dy);
      const speed = enemy.baseSpeed * enemy.speedMultiplier * (enemy.slowUntil > time ? 0.5 : 1);
      const movement = speed * DT;
      if (length <= movement) {
        core -= enemy.coreDamage;
        spawnerMoney += 5;
        enemies.splice(i, 1);
      } else {
        enemy.x += dx / length * movement;
        enemy.y += dy / length * movement;
      }
    }
  }

  function splitSwarms() {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const enemy = enemies[i];
      if (enemy.type !== 'Swarm' || distance(enemy, CENTER) > 150) continue;
      enemies.splice(i, 1);
      for (let j = 0; j < 5; j++) {
        enemies.push({ id: nextId++, type: 'Tiny', hp: 15, x: enemy.x, y: enemy.y,
          baseSpeed: 90, speedMultiplier: 1, coreDamage: 2, bounty: 1, slowUntil: 0 });
      }
    }
  }

  function towersAct() {
    for (const tower of towers) {
      if (tower.disabled) continue;
      const spec = config.towers[tower.kind];
      const inRange = enemies.filter(enemy => distance(tower, enemy) <= spec.range);
      if (tower.kind === 'Freezer') {
        for (const enemy of inRange) enemy.slowUntil = Math.max(enemy.slowUntil, time + 2);
        continue;
      }
      if (!inRange.length || time < tower.nextFireAt) continue;
      inRange.sort((a, b) => distance(a, CENTER) - distance(b, CENTER) || a.id - b.id);
      const primary = inRange[0];
      tower.nextFireAt = time + 1 / spec.rate;
      const hitList = tower.kind === 'Cannon'
        ? enemies.filter(enemy => distance(enemy, primary) <= 45)
        : [primary];
      for (const enemy of hitList) enemy.hp -= spec.damage;
    }
  }

  function collectKills() {
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].hp <= 0) {
        const dead = enemies[i];
        if (dead.type === 'Swarm') {
          for (let j = 0; j < 5; j++) {
            enemies.push({ id: nextId++, type: 'Tiny', hp: 15, x: dead.x, y: dead.y,
              baseSpeed: 90, speedMultiplier: 1, coreDamage: 2, bounty: 1, slowUntil: 0 });
          }
        }
        defenderMoney += dead.bounty; // Tower-killed parents pay 18 AND split; auto-splits do not pay.
        enemies.splice(i, 1);
      }
    }
  }

  function repairCore() {
    if (core < CORE_MAX && time >= repairReadyAt && defenderMoney >= config.repairCost) {
      defenderMoney -= config.repairCost;
      core = Math.min(CORE_MAX, core + config.repairHeal);
      repairReadyAt = time + config.repairCooldown;
    }
  }

  function payUpkeep() {
    for (const tower of towers) {
      if (time < tower.nextUpkeepAt) continue;
      while (time >= tower.nextUpkeepAt) tower.nextUpkeepAt += 10;
      if (defenderMoney >= config.upkeep) {
        defenderMoney -= config.upkeep;
        tower.disabled = false;
      } else tower.disabled = true;
    }
  }

  for (let step = 0; step < MATCH / DT && !winner; step++) {
    time = Number((step * DT).toFixed(1));
    defenderMoney += config.defenderIncome * DT;
    spawnerMoney += config.spawnerIncome(n) * DT;
    spawnerAct();
    releaseWarnings();
    buildDefenderTowers();
    moveEnemies();
    splitSwarms();
    towersAct();
    collectKills();
    repairCore();
    payUpkeep();
    if (core <= 0) { core = 0; winner = 'Spawner'; }
  }

  return { winner: winner || 'Defenders', core: Math.ceil(core), treasury: Number(defenderMoney.toFixed(2)) };
}

function batch(config, spawnerStrategy, defenderStrategy, n) {
  let defenderWins = 0, coreTotal = 0, treasuryTotal = 0;
  for (let run = 0; run < 50; run++) {
    const result = simulate({
      config, n, spawnerStrategy, defenderStrategy,
      seed: 100000 + n * 10000 + run * 7919
    });
    if (result.winner === 'Defenders') defenderWins++;
    coreTotal += result.core;
    treasuryTotal += result.treasury;
  }
  return {
    spawnerStrategy,
    defenderStrategy,
    n,
    defenderWinRate: defenderWins / 50,
    averageCoreHP: Number((coreTotal / 50).toFixed(1)),
    averageTreasury: Number((treasuryTotal / 50).toFixed(1))
  };
}

const strategies = ['runner-spam', 'swarm-rush', 'mixed', 'weakest-gate', 'human-like'];
const defenderStrategies = ['spread', 'clustered', 'lazy'];
const rows = [];
for (const spawnerStrategy of strategies) {
  for (const defenderStrategy of defenderStrategies) {
    for (const n of [1, 3, 7]) {
      rows.push(batch(BASE_CONFIG, spawnerStrategy, defenderStrategy, n));
    }
  }
}
console.log(JSON.stringify(rows, null, 2));
