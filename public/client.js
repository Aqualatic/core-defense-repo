const C = window.CoreDefenseConfig;
const socket = io(window.CoreDefenseClientConfig.serverUrl || undefined, {
  autoConnect: false, transports: ['websocket'], withCredentials: false
});
const $ = id => document.getElementById(id);
const canvas = $('gameCanvas'), ctx = canvas.getContext('2d');
canvas.width = C.map.width; canvas.height = C.map.height;
$('nickname').maxLength = C.room.nicknameLength;
$('roomCode').maxLength = C.room.codeLength;
let state = null, frames = [], credentials = null, ready = false, pending = false;
let selectedSnap = null, placing = false;
let towerType = 'Shooter', managing = false, selectedTowerId = null, selling = false;
let connectionStatus = 'Connecting…';
const storageKey = id => 'core-defense.player.' + id;
const params = new URLSearchParams(location.search);
try {
  const stored = JSON.parse(localStorage.getItem(storageKey(params.get('player'))));
  if (stored && stored.code === params.get('room')) credentials = stored;
} catch { /* The user can create/join if browser storage is unavailable. */ }

function error(message) {
  (state ? $('actionError') : $('error')).textContent = message || '';
}
function showRoom() {
  $('lobbyPanel').classList.add('hidden'); $('gamePanel').classList.remove('hidden');
  document.body.classList.add('in-room');
}
function saveIdentity(result) {
  error('');
  credentials = { code: result.code, playerId: result.playerId, reconnectToken: result.reconnectToken };
  try { localStorage.setItem(storageKey(result.playerId), JSON.stringify(credentials)); }
  catch { error('Browser storage is unavailable; refreshing cannot restore this player.'); }
  const url = new URL(location.href);
  url.search = new URLSearchParams({ room: result.code, player: result.playerId }).toString();
  history.replaceState(null, '', url);
  ready = true; showRoom(); updateHUD();
}
function request(event, payload, callback = () => {}, settled = () => {}) {
  if (!socket.connected) { settled(); return error('Connection lost. Reconnecting…'); }
  socket.timeout(C.network.requestTimeoutMs).emit(event, payload, (timeout, result) => {
    settled();
    if (timeout) return error('Request timed out. Reconnecting will recover server state.');
    if (!result.ok) return error(result.error);
    error(''); callback(result);
  });
}
function join(event) {
  const nickname = $('nickname').value.trim();
  if (!nickname) return error('Enter a nickname.');
  if (pending) return;
  pending = true;
  socket.timeout(C.network.requestTimeoutMs).emit(event,
    { nickname, code: $('roomCode').value }, (timeout, result) => {
      pending = false;
      if (timeout) return error('Could not connect. Try again.');
      if (!result.ok) return error(result.error);
      error(''); saveIdentity(result);
    });
}
$('createButton').onclick = () => join('create-room');
$('joinButton').onclick = () => join('join-room');
$('roomCode').oninput = () => { $('roomCode').value = $('roomCode').value.toUpperCase(); };
$('startButton').onclick = () => request('start-match', {});
socket.on('connect', () => {
  ready = false;
  connectionStatus = credentials ? 'Restoring player…' : 'Connected';
  updateHUD();
  if (credentials) {
    socket.timeout(C.network.requestTimeoutMs).emit('resume-room', credentials, (timeout, result) => {
      if (timeout) {
        connectionStatus = 'Restore timed out. Refresh to retry.';
        updateHUD(); return error(connectionStatus);
      }
      if (!result.ok) {
        credentials = null; ready = false; state = null; frames = [];
        history.replaceState(null, '', location.pathname);
        $('gamePanel').classList.add('hidden'); $('lobbyPanel').classList.remove('hidden');
        document.body.classList.remove('in-room'); error(result.error); return;
      }
      frames = []; saveIdentity(result);
    });
  }
});
socket.on('disconnect', () => {
  ready = false; placing = false; selling = false; connectionStatus = 'Disconnected — reconnecting…'; updateHUD();
});
socket.on('connect_error', () => {
  ready = false; connectionStatus = 'Cannot reach the server. Retrying…';
  updateHUD(); error(connectionStatus);
});
socket.on('session-replaced', () => {
  ready = false; socket.disconnect();
  connectionStatus = 'Session moved to another window'; updateHUD();
  error('This player was opened in another window. Open the base URL to join as a different player.');
});
socket.on('room-expired', () => {
  ready = false; connectionStatus = 'Room expired'; updateHUD();
  error('Room expired. Open the base URL to create a new room.');
});
socket.on('room-state', next => {
  state = next;
  frames.push({ state: next, receivedAt: performance.now() });
  if (frames.length > C.network.snapshotBuffer) frames.shift();
  updateHUD();
});
setInterval(() => { if (socket.connected) socket.emit('keep-alive'); }, C.network.keepAliveMs);

const gates = C.map.spawnGates.map((gate, gateId) => {
  const button = document.createElement('button');
  button.textContent = String(gateId + 1);
  button.title = 'Spawn Runner at gate ' + (gateId + 1);
  button.onclick = () => sendRunner(gateId);
  $('gateButtons').append(button);
  return button;
});
function canSpawn() {
  const me = state?.players.find(p => p.playerId === credentials?.playerId);
  return ready && socket.connected && me?.role === 'Spawner' && state.game.phase === 'playing' &&
    state.game.money >= C.enemies.Runner.cost && state.game.runnerCooldown <= 0;
}
function sendRunner(gateId) {
  if (canSpawn()) request('spawn-runner', { gateId });
}
function canSelectTower() {
  const me = state?.players.find(p => p.playerId === credentials?.playerId);
  return ready && socket.connected && me?.role === 'Defender' && state.game.phase === 'playing';
}
const towerButtons = Object.keys(C.towers).map(type => {
  const button = document.createElement('button');
  button.textContent = type + ' · ' + C.towers[type].cost;
  button.onclick = () => {
    if (!canSelectTower() || placing || selling || state.game.treasury < C.towers[type].cost) return;
    towerType = type; managing = false; selectedTowerId = null; error(''); updateHUD();
  };
  $('towerButtons').append(button);
  return { type, button };
});
const selectedTower = () => state?.game.towers.find(t => t.id === selectedTowerId);
function canSellTower() {
  const tower = selectedTower();
  return canSelectTower() && managing && !placing && !selling && tower &&
    tower.ownerId === credentials.playerId && tower.sellLock <= 0;
}
$('towerMode').onclick = () => {
  if (!canSelectTower() || placing || selling) return;
  managing = !managing; selectedTowerId = null; selectedSnap = null; error(''); updateHUD();
};
$('sellButton').onclick = () => {
  if (!canSellTower()) return;
  const towerId = selectedTowerId;
  selling = true; updateHUD();
  request('sell-tower', { towerId }, () => {
    if (selectedTowerId === towerId) selectedTowerId = null;
    updateHUD();
  }, () => { selling = false; updateHUD(); });
};
function canPlaceTower() {
  return canSelectTower() && !placing && !selling && !managing && selectedSnap !== null &&
    !state.game.towers.some(t => t.snapId === selectedSnap) && state.game.treasury >= C.towers[towerType].cost;
}
$('confirmPlacement').onclick = () => {
  if (!canPlaceTower()) return;
  const snapId = selectedSnap;
  placing = true; updateHUD();
  request('place-tower', { snapId, type: towerType }, () => {
    if (selectedSnap === snapId) selectedSnap = null;
    updateHUD();
  }, () => { placing = false; updateHUD(); });
};
canvas.addEventListener('pointerdown', event => {
  if (!canSpawn() && !canSelectTower()) return;
  const bounds = canvas.getBoundingClientRect();
  const x = (event.clientX - bounds.left) * canvas.width / bounds.width;
  const y = (event.clientY - bounds.top) * canvas.height / bounds.height;
  if (canSelectTower()) {
    if (placing || selling) return;
    if (managing) {
      let distance = C.ui.towerHitRadius;
      selectedTowerId = null;
      state.game.towers.forEach(tower => {
        const d = Math.hypot(x - tower.x, y - tower.y);
        if (d <= distance) { distance = d; selectedTowerId = tower.id; }
      });
      error(''); updateHUD(); return;
    }
    const occupied = new Set(state.game.towers.map(t => t.snapId));
    let distance = Infinity;
    selectedSnap = null;
    C.map.snapPoints.forEach((point, i) => {
      const d = Math.hypot(x - point.x, y - point.y);
      if (!occupied.has(i) && d < distance) { selectedSnap = i; distance = d; }
    });
    error(''); updateHUD(); return;
  }
  let chosen = -1, nearest = C.ui.gateHitRadius;
  C.map.spawnGates.forEach((gate, i) => {
    const d = Math.hypot(x - gate.x, y - gate.y);
    if (d <= nearest) { nearest = d; chosen = i; }
  });
  if (chosen >= 0) sendRunner(chosen);
});
function updateHUD() {
  $('connection').textContent = ready && socket.connected ? 'Connected' : connectionStatus;
  if (!state) return;
  const g = state.game, me = state.players.find(p => p.playerId === credentials?.playerId);
  const role = me?.role, spawner = role === 'Spawner', spectator = role === 'Spectator';
  const activeTitle = spawner ? 'Attack the Core' : role === 'Defender' ? 'Defend the Core'
    : spectator ? 'Watching the match' : 'Match in progress';
  $('roomLabel').textContent = state.code;
  $('phaseLabel').textContent = g.phase === 'countdown' ? 'Starting in ' + Math.ceil(g.countdown)
    : g.phase === 'playing' ? activeTitle : g.phase === 'finished' ? 'Match finished' : 'Lobby';
  $('roleLabel').textContent = 'Your role: ' + (me?.role || 'Joining…');
  $('hostBadge').textContent = state.hostId === me?.playerId ? 'You are host'
    : 'Host: ' + (state.players.find(p => p.playerId === state.hostId)?.nickname || 'Waiting for reconnect');
  $('coreHP').textContent = Math.ceil(g.coreHP) + ' / ' + C.match.coreHP;
  const seconds = Math.ceil(g.remaining);
  $('timer').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  $('money').textContent = Math.floor(g.money);
  $('treasury').textContent = Math.floor(g.treasury);
  $('upkeepLabel').textContent = 'Upkeep: ' + (g.towers.length * C.upkeep.cost) + ' / ' + C.upkeep.interval + 's';
  const host = me && state.hostId === me.playerId;
  $('startButton').hidden = !host || g.phase !== 'lobby';
  $('startButton').disabled = !ready || !socket.connected || !state.players.some(p => p.connected && p.role === 'Spawner') ||
    !state.players.some(p => p.connected && p.role === 'Defender');
  $('hint').textContent = !ready || !socket.connected ? connectionStatus
    : !me ? 'Confirming your player role…'
    : g.phase === 'finished' ? g.reason
    : spectator ? 'You are spectating this round. Watch the match; player actions are unavailable.'
    : g.phase === 'lobby' ? (host ? 'Start when a Spawner and Defender are connected.' : 'Waiting for the host to start the match.')
    : g.phase === 'countdown' ? (spawner ? 'Get ready to send Runners. Spawning and income start after the countdown.'
      : 'Get ready to place towers. Placement and income start after the countdown.')
    : spawner ? 'Click a numbered orange gate to send a Runner.'
    : 'Choose a tower, tap near an empty ring point, then Confirm Placement. Use Inspect / Sell to view ownership or sell your towers.';
  const runnerStatus = !ready || !socket.connected ? 'Waiting for connection'
    : g.phase === 'lobby' ? 'Available after match starts'
    : g.phase === 'countdown' ? 'Available after countdown'
    : g.phase === 'finished' ? 'Match finished'
    : g.runnerCooldown > 0 ? g.runnerCooldown.toFixed(1) + 's cooldown'
    : g.money < C.enemies.Runner.cost ? 'Not enough money' : 'Ready';
  $('runnerLabel').textContent = 'Runner · ' + C.enemies.Runner.cost + ' credits · ' + runnerStatus;
  $('runnerLabel').classList.toggle('hidden', !spawner);
  $('gateButtons').classList.toggle('hidden', !spawner);
  gates.forEach(button => { button.disabled = !canSpawn(); });
  if (!canSelectTower() || g.towers.some(t => t.snapId === selectedSnap)) selectedSnap = null;
  if (!canSelectTower()) { selectedTowerId = null; managing = false; }
  if (!selectedTower()) selectedTowerId = null;
  $('placementControls').classList.toggle('hidden', role !== 'Defender');
  towerButtons.forEach(({ type, button }) => {
    button.disabled = !canSelectTower() || placing || selling || g.treasury < C.towers[type].cost;
    button.classList.toggle('selected', type === towerType && !managing);
  });
  const stats = C.towers[towerType];
  $('towerLabel').textContent = towerType + ' · ' + stats.cost + ' credits · ' + stats.range + ' range · ' +
    (towerType === 'Freezer' ? (1 - stats.slowMultiplier) * 100 + '% slow for ' + stats.slowSeconds + 's · ' + stats.rate + ' pulse/sec'
      : stats.damage + ' damage · ' + stats.rate + ' shots/sec' + (towerType === 'Cannon' ? ' · ' + stats.splashRadius + ' splash radius' : ''));
  $('towerMode').textContent = managing ? 'Back to placement' : 'Inspect / Sell';
  $('towerMode').disabled = !canSelectTower() || placing || selling;
  $('confirmPlacement').hidden = managing;
  $('confirmPlacement').textContent = 'Confirm Placement · ' + stats.cost;
  $('confirmPlacement').disabled = !canPlaceTower();
  $('placementStatus').textContent = !ready || !socket.connected ? 'Waiting for connection'
    : g.phase === 'finished' ? 'Match finished'
    : g.phase !== 'playing' ? 'Placement opens after the countdown.'
    : selling ? 'Selling tower…'
    : managing ? 'Tap a tower to inspect it. Only its owner can sell it.'
    : placing ? 'Placing ' + towerType + '…'
    : g.towers.length === C.map.snapPoints.length ? 'All ring points are occupied.'
    : g.treasury < stats.cost ? 'Not enough money in the Shared Treasury.'
    : selectedSnap === null ? 'Select an empty ring point. Cyan towers are yours.'
    : 'Point ' + (selectedSnap + 1) + ' selected. Confirm to spend ' + stats.cost + ' from the Shared Treasury.';
  const inspected = selectedTower();
  $('towerDetails').textContent = !inspected ? '' : inspected.type + ' · Point ' + (inspected.snapId + 1) +
    ' · Owner: ' + inspected.ownerName + ' · ' + (inspected.disabled ? 'Paused: unpaid upkeep. Retry in ' : 'Active. Upkeep in ') +
    inspected.upkeepIn.toFixed(1) + 's' + (inspected.sellLock > 0 ? ' · Sell locked ' + inspected.sellLock.toFixed(1) + 's' : '');
  $('sellButton').hidden = !managing;
  $('sellButton').disabled = !canSellTower();
  $('sellButton').textContent = !inspected ? 'Select a tower' : inspected.ownerId !== credentials?.playerId ? 'Owner only'
    : 'Sell ' + inspected.type + ' · +' + inspected.sellRefund;
  $('spendFeed').replaceChildren(...g.spendFeed.slice().reverse().map(entry => {
    const li = document.createElement('li');
    li.textContent = entry.nickname + (entry.action === 'sold' ? ' sold a ' : ' placed a ') + entry.towerType +
      ' ' + (entry.cost < 0 ? '+' : '-') + Math.abs(entry.cost);
    return li;
  }));
  $('playerList').replaceChildren(...state.players.map(player => {
    const li = document.createElement('li'), name = document.createElement('span'), role = document.createElement('span');
    name.textContent = player.nickname + (player.playerId === me?.playerId ? ' (you)' : '');
    role.textContent = player.role + (!player.connected ? ' · reconnecting' : '');
    li.append(name, role); return li;
  }));
  const scores = state.players.filter(p => p.role === 'Defender').map(p =>
    g.scores.find(s => s.playerId === p.playerId) || { playerId: p.playerId, nickname: p.nickname, points: 0, kills: 0, damage: 0, assists: 0 });
  scores.push(...g.scores.filter(s => !state.players.some(p => p.playerId === s.playerId)));
  $('scoreList').replaceChildren(...scores.map(score => {
    const li = document.createElement('li');
    li.textContent = score.nickname + ': ' + score.points + ' pts · ' + score.kills + ' kills · ' + score.damage +
      ' damage · ' + score.assists + ' assists';
    return li;
  }));
}

// Render 100ms behind the newest received snapshot. Freeze on a network gap;
// never predict damage, money, spawn acceptance, or a match outcome.
function interpolated() {
  if (!frames.length) return null;
  const last = frames[frames.length - 1];
  const target = last.state.serverNow + performance.now() - last.receivedAt - C.network.interpolationMs;
  let a = frames[0], b = a;
  for (const frame of frames) {
    if (frame.state.serverNow <= target) a = frame;
    if (frame.state.serverNow >= target) { b = frame; break; }
    b = frame;
  }
  const span = b.state.serverNow - a.state.serverNow;
  const weight = span > 0 ? Math.max(0, Math.min(1, (target - a.state.serverNow) / span)) : 0;
  const later = new Map(b.state.game.enemies.map(e => [e.id, e]));
  return { ...a.state.game, enemies: a.state.game.enemies.map(e => {
    const end = later.get(e.id);
    return end ? { ...e, x: e.x + (end.x - e.x) * weight, y: e.y + (end.y - e.y) * weight } : e;
  }) };
}
function circle(x, y, radius, fill) {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}
function draw() {
  requestAnimationFrame(draw);
  const g = interpolated();
  if (!g) return;
  const m = C.map;
  ctx.fillStyle = '#071422'; ctx.fillRect(0, 0, m.width, m.height);
  ctx.strokeStyle = 'rgba(84,230,255,.08)'; ctx.lineWidth = 1;
  for (let x = 0; x <= m.width; x += C.ui.gridSpacing) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, m.height); ctx.stroke(); }
  for (let y = 0; y <= m.height; y += C.ui.gridSpacing) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(m.width, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(84,230,255,.22)'; ctx.setLineDash([8, 10]);
  ctx.beginPath(); ctx.arc(m.core.x, m.core.y, m.ringRadius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  m.snapPoints.forEach((p, i) => {
    circle(p.x, p.y, C.ui.snapRadius, selectedSnap === i ? '#e9ff95' : '#244563');
  });
  const inspected = selectedTower();
  if (selectedSnap !== null || inspected) {
    const p = inspected || m.snapPoints[selectedSnap];
    ctx.strokeStyle = '#e9ff95';
    ctx.beginPath(); ctx.arc(p.x, p.y, C.towers[inspected?.type || towerType].range, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e9ff95'; ctx.textAlign = 'center'; ctx.font = 'bold 16px system-ui';
    ctx.fillText('Point ' + ((inspected?.snapId ?? selectedSnap) + 1), p.x, p.y - C.ui.towerRadius * 2);
  }
  const glow = ctx.createRadialGradient(m.core.x, m.core.y, 0, m.core.x, m.core.y, C.ui.coreGlowRadius);
  glow.addColorStop(0, '#54e6ff'); glow.addColorStop(1, 'rgba(84,230,255,0)');
  circle(m.core.x, m.core.y, C.ui.coreGlowRadius, glow);
  circle(m.core.x, m.core.y, C.ui.coreRadius, '#dffcff');
  ctx.textAlign = 'center'; ctx.font = 'bold 16px system-ui';
  m.spawnGates.forEach((gate, i) => {
    circle(gate.x, gate.y, C.ui.gateRadius, canSpawn() ? '#ffad5a' : '#92673c');
    ctx.fillStyle = '#071422'; ctx.fillText(i + 1, gate.x, gate.y + 5);
    const warnings = g.warnings.filter(w => w.gateId === i);
    if (warnings.length) {
      const inward = Math.atan2(m.core.y - gate.y, m.core.x - gate.x);
      ctx.fillStyle = '#ffce8a';
      ctx.fillText('Runner incoming ' + Math.max(0, Math.min(...warnings.map(w => w.remaining))).toFixed(1) + 's',
        gate.x + Math.cos(inward) * 115, gate.y + Math.sin(inward) * 55);
    }
  });
  g.towers.forEach(t => {
    circle(t.x, t.y, C.ui.towerRadius, t.disabled ? '#65717b' : t.ownerId === credentials?.playerId ? '#54e6ff' : '#a7b6ff');
    ctx.fillStyle = '#11253b'; ctx.fillText(t.type[0], t.x, t.y + C.ui.healthBarHeight);
    const shot = t.lastShot;
    if (shot && g.matchTime - shot.tick / C.network.tickHz <= C.ui.shotFlashSeconds) {
      ctx.strokeStyle = t.type === 'Freezer' ? '#82d8ff' : '#e9ff95'; ctx.lineWidth = 2;
      ctx.beginPath();
      if (t.type === 'Freezer') ctx.arc(t.x, t.y, C.towers.Freezer.range, 0, Math.PI * 2);
      else { ctx.moveTo(t.x, t.y); ctx.lineTo(shot.x, shot.y); }
      ctx.stroke();
      if (t.type === 'Cannon') {
        ctx.beginPath(); ctx.arc(shot.x, shot.y, C.towers.Cannon.splashRadius, 0, Math.PI * 2); ctx.stroke();
      }
    }
  });
  g.enemies.forEach(e => {
    const slowed = e.slows?.some(s => s.untilTick > g.matchTime * C.network.tickHz);
    circle(e.x, e.y, C.ui.enemyRadius, slowed ? '#82d8ff' : '#ff6d81');
    const x = e.x - C.ui.healthBarWidth / 2, y = e.y - C.ui.enemyRadius - C.ui.healthBarHeight * 2;
    ctx.fillStyle = '#244563'; ctx.fillRect(x, y, C.ui.healthBarWidth, C.ui.healthBarHeight);
    ctx.fillStyle = '#e9ff95';
    ctx.fillRect(x, y, C.ui.healthBarWidth * e.hp / C.enemies[e.type].hp, C.ui.healthBarHeight);
  });
}
socket.connect();
requestAnimationFrame(draw);
