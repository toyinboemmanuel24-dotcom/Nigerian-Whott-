import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// IN-MEMORY REAL-TIME ROOM REGISTRY
// ==========================================
const rooms = new Map(); // roomCode -> { hostId, players: [], state: {}, sseClients: Set() }

function getOrCreateRoom(roomCode) {
  const code = roomCode.toUpperCase();
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      players: [],
      state: null,
      lastActivity: Date.now(),
      sseClients: new Set()
    });
  }
  const room = rooms.get(code);
  room.lastActivity = Date.now();
  return room;
}

function broadcastToRoom(room, eventType, data) {
  const payload = JSON.stringify({ type: eventType, data, timestamp: Date.now() });
  for (const client of room.sseClients) {
    try {
      client.res.write(`event: message\ndata: ${payload}\n\n`);
    } catch (e) {
      room.sseClients.delete(client);
    }
  }
}

// 1. Create or Reset Room
app.post('/api/rooms/:roomCode/create', (req, res) => {
  const { roomCode } = req.params;
  const { hostId, hostName, playerLimit } = req.body;
  const room = getOrCreateRoom(roomCode);

  room.hostId = hostId;
  room.playerLimit = playerLimit || 4;
  room.players = [
    {
      id: hostId,
      name: hostName || 'Host',
      avatar: '🇳🇬',
      isAi: false,
      cardCount: 0,
      score: 0,
      disqualified: false
    }
  ];
  room.state = { status: 'waiting' };

  broadcastToRoom(room, 'ROOM_UPDATED', {
    code: room.code,
    hostId: room.hostId,
    playerLimit: room.playerLimit,
    players: room.players,
    state: room.state
  });

  res.json({ success: true, room: { code: room.code, players: room.players } });
});

// 2. Join Room
app.post('/api/rooms/:roomCode/join', (req, res) => {
  const { roomCode } = req.params;
  const { id, name, avatar } = req.body;
  const room = getOrCreateRoom(roomCode);

  let existing = room.players.find(p => p.id === id);
  if (existing) {
    existing.name = name || existing.name;
    existing.avatar = avatar || existing.avatar;
  } else {
    // Check if there's space or replace an AI bot if full
    const humanCount = room.players.filter(p => !p.isAi).length;
    if (room.players.length >= (room.playerLimit || 4)) {
      const aiIndex = room.players.findIndex(p => p.isAi);
      if (aiIndex !== -1) {
        room.players.splice(aiIndex, 1);
      }
    }

    room.players.push({
      id,
      name: name || 'Friend',
      avatar: avatar || '👤',
      isAi: false,
      cardCount: 0,
      score: 0,
      disqualified: false
    });
  }

  broadcastToRoom(room, 'PLAYER_JOINED', {
    newPlayer: { id, name },
    players: room.players,
    hostId: room.hostId,
    playerLimit: room.playerLimit,
    state: room.state
  });

  res.json({ success: true, players: room.players, hostId: room.hostId, state: room.state });
});

// 3. State update (Moves, Chat Banter, Start Match)
app.post('/api/rooms/:roomCode/state', (req, res) => {
  const { roomCode } = req.params;
  const { action, payload } = req.body;
  const room = getOrCreateRoom(roomCode);

  if (action === 'LOBBY_PLAYERS_UPDATE') {
    room.players = payload.players || room.players;
  } else if (action === 'START_MATCH') {
    room.state = payload;
  } else if (action === 'GAME_STATE') {
    room.state = payload;
  }

  broadcastToRoom(room, action, payload);
  res.json({ success: true });
});

// 4. Get Room Info Snapshot
app.get('/api/rooms/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = getOrCreateRoom(roomCode);
  res.json({
    code: room.code,
    hostId: room.hostId,
    playerLimit: room.playerLimit || 4,
    players: room.players,
    state: room.state
  });
});

// 5. Server-Sent Events (SSE) stream for real-time live push to all devices
app.get('/api/rooms/:roomCode/stream', (req, res) => {
  const { roomCode } = req.params;
  const room = getOrCreateRoom(roomCode);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const client = { id: Math.random().toString(36).substring(2), res };
  room.sseClients.add(client);

  // Send initial sync snapshot
  const initialPayload = JSON.stringify({
    type: 'ROOM_SYNC',
    data: {
      code: room.code,
      hostId: room.hostId,
      playerLimit: room.playerLimit,
      players: room.players,
      state: room.state
    }
  });
  res.write(`event: message\ndata: ${initialPayload}\n\n`);

  // Heartbeat keep-alive every 20s
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      room.sseClients.delete(client);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.sseClients.delete(client);
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Nigerian Whot real-time game server running at http://${HOST}:${PORT}`);
});
