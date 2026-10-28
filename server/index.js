const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { Server } = require('socket.io');
const C = require('../shared/config');
const Game = require('./game');
const { allowedOrigins: parseOrigins } = require('./origins');

function createServer({ now = Date.now, autoTick = true, allowedOrigins } = {}) {
  const origins = parseOrigins(allowedOrigins);
  const permitted = origin => typeof origin === 'string' && origins.has(origin);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    serveClient: false,
    maxHttpBufferSize: C.network.maxPayloadBytes,
    cors: { origin: (origin, callback) => callback(null, permitted(origin)), methods: ['GET', 'POST'], credentials: false },
    allowRequest: (req, callback) => callback(null, permitted(req.headers.origin))
  });
  // Also check requests/upgrades carrying an existing Engine.IO session ID.
  io.engine.use((req, _res, next) => {
    if (!permitted(req.headers.origin)) return next(new Error('Origin not allowed.'));
    next();
  });
  const rooms = new Map();
  app.get('/health', (_req, res) => res.type('text/plain').send('ok'));
  app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function state(room) {
    return { code: room.code, hostId: room.hostId, serverNow: now(), game: Game.snapshot(room.game),
      players: [...room.players.values()].map(p => ({ playerId: p.playerId, nickname: p.nickname,
        role: p.role, connected: p.connected, reconnectUntil: p.reconnectUntil })) };
  }
  const broadcast = room => io.to(room.code).emit('room-state', state(room));
  function transferHost(room) {
    if (room.players.get(room.hostId)?.connected) return;
    room.hostId = [...room.players.values()].filter(p => p.connected)
      .sort((a, b) => a.connectedAt - b.connectedAt)[0]?.playerId || null;
  }
  function cleanup() {
    for (const room of rooms.values()) {
      let changed = false;
      for (const p of room.players.values()) {
        if (!p.connected && now() >= p.reconnectUntil) { room.players.delete(p.playerId); changed = true; }
      }
      if (!room.players.size) { rooms.delete(room.code); continue; }
      if (changed) { transferHost(room); broadcast(room); }
      if (room.game.phase === 'finished' && room.finishedAt && now() - room.finishedAt >= C.room.finishedExpiryMs) {
        io.to(room.code).emit('room-expired');
        io.in(room.code).socketsLeave(room.code);
        rooms.delete(room.code);
      }
    }
  }
  function code() {
    let value;
    do { value = Array.from({ length: C.room.codeLength }, () => C.room.codeAlphabet[randomInt(C.room.codeAlphabet.length)]).join(''); }
    while (rooms.has(value));
    return value;
  }
  function nickname(room, value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a nickname.');
    const base = Array.from(value.trim().replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, C.room.nicknameLength).join('');
    if (!base) throw new Error('Enter a nickname.');
    const used = new Set([...room.players.values()].map(p => p.nickname.toLowerCase()));
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
      const suffix = ' #' + i;
      candidate = Array.from(base).slice(0, C.room.nicknameLength - suffix.length).join('') + suffix;
    }
    return candidate;
  }
  function rate(bucket, max) {
    const time = now();
    while (bucket.length && bucket[0] <= time - C.network.rateWindowMs) bucket.shift();
    if (bucket.length >= max) return false;
    bucket.push(time); return true;
  }
  function membership(socket) {
    const room = rooms.get(socket.data.code);
    const player = room?.players.get(socket.data.playerId);
    if (!player || !player.connected || player.socketId !== socket.id) throw new Error('Join or reconnect to a room first.');
    return { room, player };
  }
  function attach(socket, room, player) {
    if (player.socketId && player.socketId !== socket.id) {
      const previous = io.sockets.sockets.get(player.socketId);
      if (previous) { previous.data.code = null; previous.emit('session-replaced'); previous.disconnect(true); }
    }
    player.connected = true; player.reconnectUntil = null;
    player.connectedAt = now(); player.socketId = socket.id;
    socket.data.code = room.code; socket.data.playerId = player.playerId;
    socket.join(room.code); transferHost(room);
    return { code: room.code, playerId: player.playerId, reconnectToken: player.token };
  }
  io.on('connection', socket => {
    socket.data.requests = [];
    function action(event, handler) {
      socket.on(event, (payload, ack) => {
        if (typeof ack !== 'function') return;
        try {
          if (!rate(socket.data.requests, C.network.generalRequestsPerSecond)) throw new Error('Too many requests. Try again shortly.');
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request.');
          cleanup();
          ack({ ok: true, ...handler(payload) });
        } catch (error) { ack({ ok: false, error: error.message }); }
      });
    }
    function addPlayer(room, name) {
      if (socket.data.code) throw new Error('This connection already has a player.');
      if (room.players.size >= C.room.maxPlayers) throw new Error('Room is full (reconnecting slots are reserved).');
      const role = room.game.phase !== 'lobby' ? 'Spectator'
        : [...room.players.values()].some(p => p.role === 'Spawner') ? 'Defender' : 'Spawner';
      const player = { playerId: randomUUID(), token: randomBytes(32).toString('hex'),
        nickname: nickname(room, name), role, requests: [], connected: false };
      room.players.set(player.playerId, player);
      const credentials = attach(socket, room, player);
      broadcast(room); return credentials;
    }
    action('create-room', payload => {
      if (socket.data.code) throw new Error('This connection already has a player.');
      const room = { code: code(), hostId: null, players: new Map(), game: Game.newGame() };
      const result = addPlayer(room, payload.nickname);
      rooms.set(room.code, room); return result;
    });
    action('join-room', payload => {
      const room = rooms.get(typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '');
      if (!room) throw new Error('Room not found.');
      return addPlayer(room, payload.nickname);
    });
    action('resume-room', payload => {
      const room = rooms.get(payload.code);
      const player = room?.players.get(payload.playerId);
      const token = typeof payload.reconnectToken === 'string' ? payload.reconnectToken : '';
      if (!player || !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(player.token))) throw new Error('Reconnect expired or invalid. Join again.');
      if (socket.data.code && (socket.data.code !== room.code || socket.data.playerId !== player.playerId)) throw new Error('Already joined as another player.');
      const result = attach(socket, room, player); broadcast(room); return result;
    });
    action('start-match', () => {
      const { room, player } = membership(socket);
      if (room.hostId !== player.playerId) throw new Error('Only the host can start.');
      const error = Game.start(room.game, [...room.players.values()]);
      if (error) throw new Error(error);
      broadcast(room); return {};
    });
    action('spawn-runner', payload => {
      const { room, player } = membership(socket);
      if (!rate(player.requests, C.network.spawnRequestsPerSecond)) throw new Error('Spawn rate limit: wait a moment.');
      const error = Game.spawnRunner(room.game, player.role, payload.gateId);
      if (error) throw new Error(error);
      return {};
    });
    socket.on('keep-alive', () => {});
    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code);
      const player = room?.players.get(socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false; player.socketId = null;
      player.reconnectUntil = now() + C.room.reconnectMs;
      transferHost(room);
      if (room.game.phase === 'countdown') { room.game.phase = 'lobby'; room.game.countdownTick = 0; }
      broadcast(room);
    });
  });

  function tick() {
    for (const room of rooms.values()) {
      Game.step(room.game);
      if (room.game.phase === 'finished' && !room.finishedAt) room.finishedAt = now();
      if (room.game.tick % (C.network.tickHz / C.network.snapshotHz) === 0) broadcast(room);
    }
  }
  let previous = performance.now(), accumulator = 0;
  const tickTimer = autoTick ? setInterval(() => {
    const current = performance.now(); accumulator += current - previous; previous = current;
    const stepMs = 1000 / C.network.tickHz;
    while (accumulator >= stepMs) { tick(); accumulator -= stepMs; }
  }, 1000 / C.network.tickHz) : null;
  const cleanupTimer = autoTick ? setInterval(cleanup, C.network.rateWindowMs) : null;
  return { server, io, rooms, tick, cleanup,
    close: async () => { clearInterval(tickTimer); clearInterval(cleanupTimer); await new Promise(resolve => io.close(resolve)); } };
}
if (require.main === module) {
  const instance = createServer();
  const port = Number(process.env.PORT || C.server.defaultPort);
  instance.server.listen(port, C.server.bindHost, () => console.log('Core Defense: http://localhost:' + port));
  process.on('SIGTERM', () => instance.close().then(() => process.exit(0)));
}
module.exports = { createServer };
