(function (root, factory) {
  const config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.CoreDefenseConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const map = { width: 1200, height: 800, core: { x: 600, y: 400 }, ringRadius: 210 };
  map.snapPoints = Array.from({ length: 16 }, (_, i) => ({
    x: map.core.x + map.ringRadius * Math.cos(i * Math.PI * 2 / 16),
    y: map.core.y + map.ringRadius * Math.sin(i * Math.PI * 2 / 16)
  }));
  map.spawnGates = [
    { x: 600, y: 30 }, { x: 1170, y: 400 }, { x: 600, y: 770 }, { x: 30, y: 400 },
    { x: 60, y: 60 }, { x: 1140, y: 60 }, { x: 1140, y: 740 }, { x: 60, y: 740 }
  ];
  return {
    map,
    room: { maxPlayers: 8, minPlayers: 2, nicknameLength: 12, codeLength: 4,
      codeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ', reconnectMs: 120000, finishedExpiryMs: 900000 },
    match: { countdownSeconds: 10, durationSeconds: 300, coreHP: 100, liveEnemyCap: 80 },
    network: { tickHz: 30, snapshotHz: 15, interpolationMs: 100, snapshotBuffer: 60,
      spawnRequestsPerSecond: 4, generalRequestsPerSecond: 10, rateWindowMs: 1000,
      keepAliveMs: 30000, requestTimeoutMs: 5000, maxPayloadBytes: 4096 },
    server: { defaultPort: 3000, bindHost: '0.0.0.0' },
    economy: { defenderStart: 150, defenderStartPerExtra: 10, defenderIncome: 5,
      spawnerStart: 150, spawnerIncomeBase: 4, spawnerIncomePerDefender: 0.5, coreHitReward: 5 },
    spawnWarningSeconds: 2,
    enemies: {
      Runner: { cost: 20, hp: 20, speed: 120, coreDamage: 3, cooldown: 1.5, bounty: 6 },
      Tank: { cost: 80, hp: 300, speed: 35, coreDamage: 15, cooldown: 8, bounty: 24 },
      Swarm: { cost: 60, hp: 100, speed: 65, coreDamage: 0, cooldown: 6, bounty: 18 },
      Tiny: { cost: 0, hp: 15, speed: 90, coreDamage: 2, cooldown: 0, bounty: 1 }
    },
    towers: {
      Shooter: { cost: 50, range: 120, damage: 12, rate: 2 },
      Cannon: { cost: 120, range: 150, damage: 80, rate: 0.5 },
      Freezer: { cost: 90, range: 100, damage: 0, rate: 1 }
    },
    upkeep: { cost: 1, interval: 10 }, repair: { cost: 60, heal: 5, cooldown: 20 },
    ui: { gridSpacing: 60, gateRadius: 18, gateHitRadius: 40, enemyRadius: 10,
      coreRadius: 18, coreGlowRadius: 60, snapRadius: 7 }
  };
});
