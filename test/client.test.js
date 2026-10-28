const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../shared/config');

// Run the shipped client with DOM/transport boundaries supplied by the test.
// This exercises snapshot and reconnect ordering without a browser dependency.
function client({ refreshed = false, serverUrl = '', pageOrigin = 'http://localhost:3000' } = {}) {
  const painted = [], ctx = {};
  for (const name of ['beginPath', 'arc', 'fill', 'fillRect', 'moveTo', 'lineTo', 'stroke', 'setLineDash', 'fillText']) {
    ctx[name] = (...args) => painted.push({ name, args });
  }
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  let animationFrame;
  function element() {
    const classes = new Set();
    let text = '';
    return { get textContent() { return text; }, set textContent(value) { text = String(value); },
      value: '', hidden: false, disabled: false, children: [],
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, handler) { this['on' + name] = handler; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }), getContext: () => ctx };
  }
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], element()]));
  const credentials = { code: 'ABCD', playerId: 'me', reconnectToken: 'test-token' };
  const handlers = {}, sent = [], stored = new Map();
  if (refreshed) stored.set('core-defense.player.me', JSON.stringify(credentials));
  const socket = { connected: false, on(name, fn) { handlers[name] = fn; },
    timeout() { return this; }, emit(name, payload, ack) { sent.push({ name, payload, ack }); },
    connect() { this.connected = true; handlers.connect(); },
    disconnect() { this.connected = false; handlers.disconnect(); } };
  let connection;
  const context = vm.createContext({ window: { CoreDefenseConfig: C, CoreDefenseClientConfig: { serverUrl } },
    document: { getElementById: id => elements[id], createElement: element, body: element() },
    io: (url, options) => { connection = { url, options }; return socket; }, URL, URLSearchParams,
    location: { href: pageOrigin + '/' + (refreshed ? '?room=ABCD&player=me' : ''),
      search: refreshed ? '?room=ABCD&player=me' : '', pathname: '/' },
    history: { replaceState() {} }, localStorage: { getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value) },
    performance: { now: () => 100 }, setInterval() {}, requestAnimationFrame(fn) { animationFrame = fn; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/client.js'), 'utf8'), context);
  function acknowledge(name) {
    const request = sent.findLast(r => r.name === name);
    assert.ok(request, name + ' request sent');
    request.ack(null, { ok: true, ...credentials });
  }
  if (!refreshed) {
    elements.nickname.value = 'Sam'; elements.createButton.onclick(); acknowledge('create-room');
  }
  return { elements, socket, sent, stored, connection, acknowledge, painted, draw: () => animationFrame(),
    event: (name, value) => handlers[name](value),
    snapshot(role, phase = 'playing', options = {}) {
      const money = options.game?.money ?? 150;
      const spawns = Object.fromEntries(C.spawnTypes.map(type => {
        const cooldown = type === 'Runner' ? options.game?.runnerCooldown || 0 : 0;
        const moneyBlocked = money < C.enemies[type].cost;
        return [type, { cooldown, moneyBlocked, capBlocked: false, ready: !cooldown && !moneyBlocked }];
      }));
      handlers['room-state']({ code: 'ABCD', serverNow: 100, hostId: options.hostId || 'me',
        players: [{ playerId: 'me', role, nickname: 'Sam', connected: true },
          { playerId: 'other', role: role === 'Spawner' ? 'Defender' : 'Spawner', nickname: 'Alex', connected: true }],
        game: { phase, coreHP: 97, remaining: 295, countdown: 10, money: 150, runnerCooldown: 0,
          spawns, enemySlots: { used: 0, cap: C.match.liveEnemyCap }, repairCooldown: 0,
          spawnDiagnostics: { perTypeSeconds: { Runner: 0, Tank: 0, Swarm: 0 }, anyTypeSeconds: 0, allAffordableSeconds: 0 },
          reason: 'Defenders win: the Core survived.', enemies: [], warnings: [],
          treasury: 150, upkeepPerTower: 1, towers: [], scores: [], spendFeed: [], ...options.game } });
    } };
}

test('active heading, hints and spawn controls follow the current role on every snapshot', () => {
  const f = client(), e = f.elements;
  f.snapshot('Spawner');
  assert.equal(e.phaseLabel.textContent, 'Attack the Core');
  assert.match(e.hint.textContent, /Runner.*gate/);
  assert.equal(e.gateButtons.classList.contains('hidden'), false);
  assert.ok(e.gateButtons.children.every(b => !b.disabled));
  f.snapshot('Defender');
  assert.equal(e.phaseLabel.textContent, 'Defend the Core');
  assert.match(e.hint.textContent, /Confirm Placement/);
  assert.equal(e.gateButtons.classList.contains('hidden'), true);
  assert.equal(e.runnerLabel.classList.contains('hidden'), true);
  assert.ok(e.gateButtons.children.every(b => b.disabled));
  f.snapshot('Spectator');
  assert.equal(e.phaseLabel.textContent, 'Watching the match');
  assert.match(e.hint.textContent, /spectating/i);
  assert.doesNotMatch(e.hint.textContent, /Defend|Click|Towers arrive/);
  f.snapshot('Spawner');
  assert.equal(e.roleLabel.textContent, 'Your role: Spawner');
  assert.equal(e.runnerLabel.classList.contains('hidden'), false);
  assert.equal(e.gateButtons.classList.contains('hidden'), false);
});

test('canvas draws selection range, owned towers, authoritative shot lines and damaged Runner health', () => {
  const f = client();
  f.snapshot('Defender', 'playing', { game: { matchTime: 3,
    enemies: [{ id: 8, type: 'Runner', x: 600, y: 90, hp: 8 }],
    towers: [{ snapId: 12, x: 600, y: 190, type: 'Shooter', ownerId: 'me',
      lastShot: { tick: 86, targetId: 8, x: 600, y: 86 } }] } });
  f.elements.gameCanvas.onpointerdown({ clientX: 405, clientY: 200 });
  f.draw();
  assert.ok(f.painted.some(p => p.name === 'arc' && p.args[0] === 810 && p.args[2] === 120));
  assert.ok(f.painted.some(p => p.name === 'lineTo' && p.args[0] === 600 && p.args[1] === 86));
  assert.ok(f.painted.some(p => p.name === 'fillRect' && Math.abs(p.args[2] - 9.6) < 1e-8));
});

test('canvas renders Cannon splash, Freezer pulses, type labels and slowed enemies from snapshots', () => {
  const f = client();
  f.snapshot('Defender', 'playing', { game: { matchTime: 3,
    enemies: [{ id: 8, type: 'Runner', x: 600, y: 90, hp: 8, slows: [{ untilTick: 120 }] }],
    towers: [{ id: 1, snapId: 12, x: 600, y: 190, type: 'Cannon', ownerId: 'me',
      lastShot: { tick: 86, x: 600, y: 86 } },
    { id: 2, snapId: 0, x: 810, y: 400, type: 'Freezer', ownerId: 'other',
      lastShot: { tick: 86, x: 810, y: 400 } }] } });
  f.draw();
  assert.ok(f.painted.some(p => p.name === 'arc' && p.args[0] === 600 && p.args[1] === 86 && p.args[2] === 45));
  assert.ok(f.painted.some(p => p.name === 'arc' && p.args[0] === 810 && p.args[2] === 100));
  assert.ok(f.painted.some(p => p.name === 'fillText' && p.args[0] === 'C'));
  assert.ok(f.painted.some(p => p.name === 'fillText' && p.args[0] === 'F'));
});

test('Defender taps the nearest empty point, then confirms; selecting alone never spends', () => {
  const f = client(), e = f.elements;
  f.snapshot('Defender');
  assert.equal(e.placementControls.classList.contains('hidden'), false);
  assert.equal(e.confirmPlacement.disabled, true);
  // Canvas is rendered at half logical size: tap near the top ring point.
  e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  assert.match(e.placementStatus.textContent, /13/);
  assert.equal(f.sent.filter(r => r.name === 'place-tower').length, 0);
  assert.equal(e.confirmPlacement.disabled, false);
  e.confirmPlacement.onclick(); e.confirmPlacement.onclick();
  assert.equal(f.sent.filter(r => r.name === 'place-tower').length, 1);
  assert.equal(f.sent.find(r => r.name === 'place-tower').payload.snapId, 12);
  assert.equal(e.confirmPlacement.disabled, true);
  f.acknowledge('place-tower'); assert.equal(e.confirmPlacement.disabled, true);
  f.snapshot('Defender', 'playing', { game: { towers: [{ snapId: 12 }] } });
  e.gameCanvas.onpointerdown({ clientX: 301, clientY: 95 });
  e.confirmPlacement.onclick();
  assert.notEqual(f.sent.findLast(r => r.name === 'place-tower').payload.snapId, 12);
});

test('placement controls, affordability and selection follow role/phase/reconnect and occupied snapshots', () => {
  const f = client(), e = f.elements;
  for (const role of ['Spawner', 'Defender', 'Spectator']) {
    for (const phase of ['lobby', 'countdown', 'playing', 'finished']) {
      f.snapshot(role, phase);
      e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
      assert.equal(e.placementControls.classList.contains('hidden'), role !== 'Defender');
      assert.equal(e.confirmPlacement.disabled, !(role === 'Defender' && phase === 'playing'));
    }
  }
  f.snapshot('Defender', 'playing', { game: { treasury: 49 } });
  e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  assert.equal(e.confirmPlacement.disabled, true); assert.match(e.placementStatus.textContent, /Not enough/);
  f.snapshot('Defender'); assert.equal(e.confirmPlacement.disabled, false);
  f.snapshot('Defender', 'playing', { game: { towers: [{ snapId: 12 }] } });
  assert.equal(e.confirmPlacement.disabled, true);
  e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  f.socket.disconnect(); assert.equal(e.confirmPlacement.disabled, true);
  f.socket.connect(); f.snapshot('Defender'); assert.equal(e.confirmPlacement.disabled, true);
  f.acknowledge('resume-room');
  assert.equal(e.confirmPlacement.disabled, true); // A refresh/reconnect needs a fresh selection.
  assert.match(e.hint.textContent, /Confirm Placement/);
});

test('shared treasury and spend feed update for every role, with nicknames as literal text', () => {
  const f = client(), e = f.elements;
  for (const role of ['Spawner', 'Defender', 'Spectator']) {
    f.snapshot(role, 'playing', { game: { treasury: 106.8,
      spendFeed: [{ nickname: '<b>Sam</b>', towerType: 'Shooter', cost: 50 }] } });
    assert.equal(e.treasury.textContent, '106');
    assert.equal(e.spendFeed.children[0].textContent, '<b>Sam</b> placed a Shooter -50');
  }
});

test('tower choices send the selected type, show config costs and gate affordability', () => {
  for (const [index, type, cost] of [[1, 'Cannon', 120], [2, 'Freezer', 90]]) {
    const f = client(), e = f.elements; f.snapshot('Defender');
    const button = e.towerButtons.children[index]; button.onclick();
    assert.match(e.towerLabel.textContent, new RegExp(type));
    e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
    assert.equal(e.confirmPlacement.textContent, 'Confirm Placement · ' + cost);
    e.confirmPlacement.onclick();
    assert.equal(f.sent.findLast(r => r.name === 'place-tower').payload.type, type);
  }
  const f = client(), e = f.elements;
  f.snapshot('Defender', 'playing', { game: { treasury: 89 } });
  assert.equal(e.towerButtons.children[0].disabled, false);
  assert.equal(e.towerButtons.children[1].disabled, true);
  assert.equal(e.towerButtons.children[2].disabled, true);
  f.snapshot('Spawner'); assert.ok(e.towerButtons.children.every(b => b.disabled));
  f.snapshot('Defender', 'countdown'); assert.ok(e.towerButtons.children.every(b => b.disabled));
});

test('Inspect/Sell shows ownership and lock, sends tower ID once, and resets through reconnect', () => {
  const f = client(), e = f.elements;
  const tower = { id: 7, snapId: 12, type: 'Cannon', ownerId: 'me', ownerName: '<b>Sam</b>',
    x: 600, y: 190, sellLock: 1, sellRefund: 60, upkeepIn: 10, disabled: false };
  const snapshot = () => f.snapshot('Defender', 'playing', { game: { towers: [tower] } });
  snapshot(); e.towerMode.onclick(); e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  assert.match(e.towerDetails.textContent, /Owner: <b>Sam<\/b>/);
  assert.match(e.towerDetails.textContent, /locked/); assert.equal(e.sellButton.disabled, true);
  assert.equal(e.confirmPlacement.hidden, true);
  tower.sellLock = 0; snapshot(); assert.equal(e.sellButton.disabled, false);
  tower.ownerId = 'other'; snapshot(); assert.equal(e.sellButton.textContent, 'Owner only');
  assert.equal(e.sellButton.disabled, true);
  tower.ownerId = 'me'; snapshot(); e.sellButton.onclick(); e.sellButton.onclick();
  assert.equal(f.sent.filter(r => r.name === 'sell-tower').length, 1);
  assert.equal(f.sent.findLast(r => r.name === 'sell-tower').payload.towerId, 7);
  f.acknowledge('sell-tower'); assert.equal(e.sellButton.disabled, true);
  e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  f.socket.disconnect(); assert.equal(e.sellButton.disabled, true);
  f.socket.connect(); snapshot(); f.acknowledge('resume-room');
  assert.equal(e.sellButton.hidden, true); assert.equal(e.confirmPlacement.disabled, true);
});

test('scores and sale refunds are safe text and remain visible through role changes', () => {
  const f = client(), e = f.elements;
  for (const role of ['Spawner', 'Defender', 'Spectator']) {
    f.snapshot(role, 'playing', { game: { scores: [{ playerId: 'retired', nickname: '<i>Lee</i>', points: 35, kills: 1, damage: 20, assists: 1 }],
      spendFeed: [{ nickname: '<b>Sam</b>', action: 'sold', towerType: 'Cannon', cost: -60 }] } });
    assert.equal(e.scoreList.children.at(-1).textContent, '<i>Lee</i>: 35 pts · 1 kills · 20 damage · 1 slow assists · 0 repairs');
    assert.equal(e.spendFeed.children[0].textContent, '<b>Sam</b> sold a Cannon +60');
  }
});

test('one server URL selects same-origin or remote WebSockets; refresh uses frontend storage tokens', () => {
  const local = client();
  assert.equal(local.connection.url, undefined);
  const hosted = client({ refreshed: true, serverUrl: 'https://game-server.example', pageOrigin: 'https://core-defense.example' });
  assert.equal(hosted.connection.url, 'https://game-server.example');
  assert.deepEqual(Array.from(hosted.connection.options.transports), ['websocket']);
  assert.equal(hosted.connection.options.withCredentials, false);
  const resume = hosted.sent.find(r => r.name === 'resume-room');
  assert.equal(resume.payload.playerId, 'me');
  assert.equal(resume.payload.reconnectToken, 'test-token');
  hosted.snapshot('Spawner'); hosted.acknowledge('resume-room');
  assert.equal(hosted.elements.roleLabel.textContent, 'Your role: Spawner');
  const saved = JSON.parse(hosted.stored.get('core-defense.player.me'));
  assert.equal(saved.reconnectToken, 'test-token');
});

test('lobby, countdown, active and finished controls never claim a blocked spawn is ready', () => {
  const f = client(), e = f.elements;
  f.snapshot('Spawner', 'lobby');
  assert.equal(e.phaseLabel.textContent, 'Lobby');
  assert.equal(e.startButton.hidden, false);
  assert.equal(e.startButton.disabled, false);
  assert.doesNotMatch(e.runnerLabel.textContent, /Ready/);
  f.snapshot('Spawner', 'countdown');
  assert.equal(e.phaseLabel.textContent, 'Starting in 10');
  assert.equal(e.startButton.hidden, true);
  assert.doesNotMatch(e.runnerLabel.textContent, /Ready/);
  assert.ok(e.gateButtons.children.every(b => b.disabled));
  f.snapshot('Spawner', 'playing', { game: { money: 0 } });
  assert.match(e.runnerLabel.textContent, /Not enough money/);
  f.snapshot('Spawner', 'playing', { game: { runnerCooldown: 1.5 } });
  assert.match(e.runnerLabel.textContent, /1.5s cooldown/);
  f.snapshot('Spawner', 'finished');
  assert.equal(e.phaseLabel.textContent, 'Match finished');
  assert.equal(e.hint.textContent, 'Defenders win: the Core survived.');
  assert.doesNotMatch(e.runnerLabel.textContent, /Ready/);
});

test('host controls follow host identity independently of role; shared labels stay neutral', () => {
  const f = client(), e = f.elements;
  for (const role of ['Spawner', 'Defender', 'Spectator']) {
    for (const phase of ['lobby', 'countdown', 'playing', 'finished']) {
      f.snapshot(role, phase, { hostId: 'other' });
      assert.equal(e.startButton.hidden, true);
      assert.equal(e.hostBadge.textContent, 'Host: Alex');
      assert.equal(e.coreHP.textContent, '97 / 100');
      assert.equal(e.timer.textContent, '4:55');
      assert.equal(e.money.textContent, '150');
      assert.equal(e.roleLabel.textContent, 'Your role: ' + role);
      assert.equal(e.runnerLabel.classList.contains('hidden'), role !== 'Spawner');
    }
  }
  f.snapshot('Defender', 'lobby');
  assert.equal(e.hostBadge.textContent, 'You are host');
  assert.equal(e.startButton.hidden, false);
  assert.equal(e.startButton.disabled, false);
});

test('refresh and reconnect wait for identity confirmation, then use the latest server role', () => {
  for (const role of ['Spawner', 'Defender', 'Spectator']) {
    for (const phase of ['lobby', 'countdown', 'playing']) {
      const f = client({ refreshed: true }), e = f.elements;
      f.snapshot(role, phase);
      assert.match(e.connection.textContent, /Restoring/);
      assert.match(e.hint.textContent, /Restoring/);
      assert.ok(e.gateButtons.children.every(b => b.disabled));
      assert.equal(e.startButton.disabled, true);
      f.acknowledge('resume-room');
      assert.equal(e.connection.textContent, 'Connected');
      assert.equal(e.roleLabel.textContent, 'Your role: ' + role);
      assert.doesNotMatch(e.hint.textContent, /Restoring/);
      f.socket.disconnect();
      assert.match(e.hint.textContent, /reconnecting/);
      assert.doesNotMatch(e.runnerLabel.textContent, /Ready/);
      f.socket.connect();
      f.snapshot('Spectator', 'playing');
      f.acknowledge('resume-room');
      assert.equal(e.phaseLabel.textContent, 'Watching the match');
      assert.match(e.hint.textContent, /spectating/i);
      assert.equal(e.gateButtons.classList.contains('hidden'), true);
    }
  }
});

test('expired rooms and moved sessions replace stale action guidance and disable controls', () => {
  for (const event of ['room-expired', 'session-replaced']) {
    const f = client(), e = f.elements;
    f.snapshot('Spawner');
    f.event(event);
    assert.ok(e.gateButtons.children.every(b => b.disabled));
    assert.doesNotMatch(e.hint.textContent, /Click|reconnecting/);
    assert.match(e.connection.textContent, event === 'room-expired' ? /Room expired/ : /Session moved/);
    assert.doesNotMatch(e.runnerLabel.textContent, /Ready/);
  }
});

test('enemy choices send the chosen type and show money, cooldown and capacity blocks independently', () => {
  const f = client(), e = f.elements;
  for (const [index, type] of C.spawnTypes.entries()) {
    f.snapshot('Spawner'); e.enemyButtons.children[index].onclick(); e.gateButtons.children[0].onclick();
    const sent = f.sent.findLast(r => r.name === 'spawn-enemy');
    assert.equal(sent.payload.type, type); assert.equal(sent.payload.gateId, 0);
  }
  f.snapshot('Spawner', 'playing', { game: { money: 0, spawns: {
    Runner: { moneyBlocked: true, cooldown: 1.5, capBlocked: false, ready: false },
    Tank: { moneyBlocked: true, cooldown: 0, capBlocked: false, ready: false },
    Swarm: { moneyBlocked: true, cooldown: 4, capBlocked: true, ready: false }
  }, spawnDiagnostics: { perTypeSeconds: { Runner: 1.5, Tank: 0, Swarm: 4 }, allAffordableSeconds: 1.5 } } });
  assert.match(e.enemyButtons.children[0].textContent, /Not enough money.*1.5s cooldown/);
  assert.match(e.enemyButtons.children[2].textContent, /Not enough money.*4.0s cooldown.*needs 5 slots/);
  assert.ok(e.enemyButtons.children.every(b => b.disabled));
  assert.match(e.spawnDiagnostics.textContent, /Runner 1.5s.*Swarm 4.0s.*All affordable types blocked: 1.5s/);
  assert.equal(e.enemySlotsLabel.textContent, 'Enemy slots: 0 / 80');
  const before = f.sent.length; e.gateButtons.children[0].onclick(); assert.equal(f.sent.length, before);
  f.snapshot('Defender'); assert.equal(e.enemyButtons.classList.contains('hidden'), true);
  assert.equal(e.spawnDiagnostics.classList.contains('hidden'), true);
  f.snapshot('Spawner', 'countdown'); assert.ok(e.enemyButtons.children.every(b => b.disabled));
  f.socket.disconnect(); f.socket.connect(); f.snapshot('Spawner');
  assert.ok(e.enemyButtons.children.every(b => b.disabled));
  f.acknowledge('resume-room'); assert.ok(e.enemyButtons.children.every(b => !b.disabled));
});

test('Core Repair controls enforce role, phase, funds, HP, shared cooldown and pending reconnect state', () => {
  const f = client(), e = f.elements;
  f.snapshot('Defender'); assert.equal(e.repairControls.classList.contains('hidden'), false);
  assert.match(e.repairButton.textContent, /60.*up to 5 HP/); assert.equal(e.repairButton.disabled, false);
  e.repairButton.onclick(); e.repairButton.onclick();
  assert.equal(f.sent.filter(r => r.name === 'repair-core').length, 1); assert.equal(e.repairButton.disabled, true);
  f.acknowledge('repair-core');
  for (const game of [{ coreHP: 100 }, { treasury: 59 }, { repairCooldown: 19.9 }]) {
    f.snapshot('Defender', 'playing', { game }); assert.equal(e.repairButton.disabled, true);
  }
  assert.match(e.repairStatus.textContent, /19.9s shared cooldown/);
  for (const phase of ['lobby', 'countdown', 'finished']) {
    f.snapshot('Defender', phase); assert.equal(e.repairButton.disabled, true);
  }
  for (const role of ['Spawner', 'Spectator']) {
    f.snapshot(role); assert.equal(e.repairControls.classList.contains('hidden'), true);
    assert.equal(e.repairButton.disabled, true);
  }
  f.snapshot('Defender'); f.socket.disconnect(); f.socket.connect(); f.snapshot('Defender');
  assert.equal(e.repairButton.disabled, true); f.acknowledge('resume-room');
  assert.equal(e.repairButton.disabled, false);
});

test('paused towers, resume/repair feed and winning Spawner score are visible as safe text', () => {
  const f = client(), e = f.elements;
  f.snapshot('Defender', 'playing', { game: { towers: [{ id: 7, snapId: 12, type: 'Shooter', ownerId: 'me',
    ownerName: '<b>Sam</b>', x: 600, y: 190, disabled: true, upkeepIn: 8, sellLock: 0, sellRefund: 25 }],
    spendFeed: [{ nickname: '<b>Sam</b>', action: 'resumed', towerType: 'Shooter', cost: 1 },
      { nickname: 'Lee', action: 'repaired', healed: 3, cost: 60 }],
    scores: [{ playerId: 'other', role: 'Spawner', nickname: 'Alex', points: 600, coreDamage: 100, winBonus: 100 }] } });
  assert.match(e.upkeepAlerts.children[0].textContent, /point 13.*<b>Sam<\/b>: paused: can't pay upkeep/);
  e.towerMode.onclick(); e.gameCanvas.onpointerdown({ clientX: 300, clientY: 95 });
  assert.match(e.towerDetails.textContent, /paused: can't pay upkeep/);
  assert.equal(e.spendFeed.children[0].textContent, 'Lee repaired Core +3 HP -60');
  assert.equal(e.spendFeed.children[1].textContent, "<b>Sam</b>'s Shooter resumed: upkeep paid -1");
  assert.match(e.scoreList.children[1].textContent, /600 pts.*100 Core damage.*Win \+100/);
  f.draw(); assert.ok(f.painted.some(p => p.name === 'fillText' && p.args[0] === 'PAUSED'));
});

test('typed warnings and overlapping Tinies render from authoritative snapshots', () => {
  const f = client(); f.snapshot('Spawner', 'playing', { game: {
    enemies: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, type: 'Tiny', x: 600, y: 251, hp: 15 })),
    warnings: [{ id: 6, type: 'Swarm', gateId: 0, remaining: 2 }, { id: 7, type: 'Tank', gateId: 2, remaining: 1 }]
  } }); f.draw();
  const labels = f.painted.filter(p => p.name === 'fillText').map(p => p.args[0]);
  assert.ok(labels.includes('Tiny ×5')); assert.ok(labels.includes('Swarm incoming 2.0s'));
  assert.ok(labels.includes('Tank incoming 1.0s'));
});

test('upkeep HUD uses the server bill when an experiment is enabled', () => {
  const f = client(), e = f.elements;
  f.snapshot('Defender', 'playing', { game: { upkeepPerTower: 2,
    towers: Array.from({ length: 16 }, (_, i) => ({ id: i + 1, snapId: i, type: 'Shooter' })) } });
  assert.equal(e.upkeepLabel.textContent, 'Upkeep: 32 / 10s');
});
