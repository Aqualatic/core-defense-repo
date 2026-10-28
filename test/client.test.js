const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../shared/config');

// Run the shipped client with DOM/transport boundaries supplied by the test.
// This exercises snapshot and reconnect ordering without a browser dependency.
function client({ refreshed = false, serverUrl = '', pageOrigin = 'http://localhost:3000' } = {}) {
  function element() {
    const classes = new Set();
    let text = '';
    return { get textContent() { return text; }, set textContent(value) { text = String(value); },
      value: '', hidden: false, disabled: false, children: [],
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener() {}, getContext: () => ({}) };
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
    performance: { now: () => 100 }, setInterval() {}, requestAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/client.js'), 'utf8'), context);
  function acknowledge(name) {
    const request = sent.findLast(r => r.name === name);
    assert.ok(request, name + ' request sent');
    request.ack(null, { ok: true, ...credentials });
  }
  if (!refreshed) {
    elements.nickname.value = 'Sam'; elements.createButton.onclick(); acknowledge('create-room');
  }
  return { elements, socket, sent, stored, connection, acknowledge, event: (name, value) => handlers[name](value),
    snapshot(role, phase = 'playing', options = {}) {
      handlers['room-state']({ code: 'ABCD', serverNow: 100, hostId: options.hostId || 'me',
        players: [{ playerId: 'me', role, nickname: 'Sam', connected: true },
          { playerId: 'other', role: role === 'Spawner' ? 'Defender' : 'Spawner', nickname: 'Alex', connected: true }],
        game: { phase, coreHP: 97, remaining: 295, countdown: 10, money: 150, runnerCooldown: 0,
          reason: 'Defenders win: the Core survived.', enemies: [], warnings: [], ...options.game } });
    } };
}

test('active heading, hints and spawn controls follow the current role on every snapshot', () => {
  const f = client(), e = f.elements;
  f.snapshot('Spawner');
  assert.equal(e.phaseLabel.textContent, 'Attack the Core');
  assert.match(e.hint.textContent, /gate.*Runner/);
  assert.equal(e.gateButtons.classList.contains('hidden'), false);
  assert.ok(e.gateButtons.children.every(b => !b.disabled));
  f.snapshot('Defender');
  assert.equal(e.phaseLabel.textContent, 'Defend the Core');
  assert.match(e.hint.textContent, /Towers arrive in the next milestone/);
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
