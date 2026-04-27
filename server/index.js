import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const STARTING_CASH = 1500;
const PASS_GO_BONUS = 200;
const TURN_MS = 15000;
const HOST_GRACE_MS = 120000;
const JAIL_SPACE_ID = 5;

const BOARD = [
  { id: 0, name: 'GO', type: 'start', description: 'Collect $200 when you pass.' },
  { id: 1, name: 'Mediterranean Avenue', type: 'property', cost: 60, rent: 12, color: 'brown' },
  { id: 2, name: 'Community Chest', type: 'event', deck: 'community' },
  { id: 3, name: 'Baltic Avenue', type: 'property', cost: 60, rent: 16, color: 'brown' },
  { id: 4, name: 'Income Tax', type: 'tax', amount: 120 },
  { id: 5, name: 'Jail / Visit', type: 'jail' },
  { id: 6, name: 'Oriental Avenue', type: 'property', cost: 100, rent: 22, color: 'light-blue' },
  { id: 7, name: 'Chance', type: 'event', deck: 'chance' },
  { id: 8, name: 'Vermont Avenue', type: 'property', cost: 100, rent: 24, color: 'light-blue' },
  { id: 9, name: 'Connecticut Avenue', type: 'property', cost: 120, rent: 28, color: 'light-blue' },
  { id: 10, name: 'Free Parking', type: 'bonus', amount: 75 },
  { id: 11, name: 'St. Charles Place', type: 'property', cost: 140, rent: 32, color: 'pink' },
  { id: 12, name: 'Electric Company', type: 'utility', cost: 150, rent: 36, color: 'utility' },
  { id: 13, name: 'States Avenue', type: 'property', cost: 140, rent: 34, color: 'pink' },
  { id: 14, name: 'Virginia Avenue', type: 'property', cost: 160, rent: 38, color: 'pink' },
  { id: 15, name: 'Go To Jail', type: 'go_to_jail' },
  { id: 16, name: 'Pennsylvania Railroad', type: 'railroad', cost: 200, rent: 40, color: 'railroad' },
  { id: 17, name: 'Chance', type: 'event', deck: 'chance' },
  { id: 18, name: 'Kentucky Avenue', type: 'property', cost: 220, rent: 46, color: 'red' },
  { id: 19, name: 'Boardwalk', type: 'property', cost: 400, rent: 60, color: 'dark-blue' }
];

const EVENT_CARDS = {
  chance: [
    {
      text: 'Advance to GO and collect $200.',
      apply: (room, player) => {
        movePlayerTo(room, player, 0, true);
        pushLog(room, `${player.name} advanced to GO.`);
      }
    },
    {
      text: 'Speeding fine. Pay $40.',
      apply: (room, player) => {
        applyCashDelta(room, player, -40, `${player.name} paid a $40 speeding fine.`);
      }
    },
    {
      text: 'Move forward 3 spaces.',
      apply: (room, player) => {
        movePlayerBy(room, player, 3);
        pushLog(room, `${player.name} advanced 3 spaces.`);
      }
    },
    {
      text: 'Go directly to jail.',
      apply: (room, player) => {
        sendPlayerToJail(room, player, `${player.name} was sent directly to jail.`);
      }
    }
  ],
  community: [
    {
      text: 'Bank error in your favor. Collect $120.',
      apply: (room, player) => {
        applyCashDelta(room, player, 120, `${player.name} collected $120 from the bank.`);
      }
    },
    {
      text: 'Street repairs. Pay $60.',
      apply: (room, player) => {
        applyCashDelta(room, player, -60, `${player.name} paid $60 for street repairs.`);
      }
    },
    {
      text: 'Collect a quick bonus of $80.',
      apply: (room, player) => {
        applyCashDelta(room, player, 80, `${player.name} picked up a quick bonus of $80.`);
      }
    },
    {
      text: 'Head to Free Parking.',
      apply: (room, player) => {
        movePlayerTo(room, player, 10, false);
        pushLog(room, `${player.name} moved to Free Parking.`);
      }
    }
  ]
};

const rooms = new Map();

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function makeRoomCode() {
  let code = randomCode();

  while (rooms.has(code)) {
    code = randomCode();
  }

  return code;
}

function createPlayer(connectionId, name) {
  return {
    id: connectionId,
    reconnectToken: randomUUID(),
    name,
    cash: STARTING_CASH,
    position: 0,
    ready: false,
    connected: true,
    bankrupt: false,
    jailTurns: 0,
    lastRoll: null
  };
}

function createRoom(hostSocket) {
  return {
    code: makeRoomCode(),
    phase: 'lobby',
    host: {
      socket: hostSocket,
      reconnectToken: randomUUID(),
      connected: true,
      cleanupHandle: null
    },
    clients: [],
    players: [],
    ownership: {},
    turnPlayerId: null,
    turnDeadline: null,
    turnTimer: null,
    pendingAction: null,
    lastEvent: null,
    winnerId: null,
    log: []
  };
}

function clearRoomCleanup(room) {
  if (room.host.cleanupHandle) {
    clearTimeout(room.host.cleanupHandle);
    room.host.cleanupHandle = null;
  }
}

function scheduleRoomCleanup(room) {
  clearRoomCleanup(room);
  room.host.cleanupHandle = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || currentRoom.host.connected) {
      return;
    }

    currentRoom.clients.forEach((client) => {
      if (client.socket?.readyState === client.socket.OPEN) {
        send(client.socket, 'error', { message: 'Host did not reconnect. Room closed.' });
        client.socket.close();
      }
    });

    clearTurnTimer(currentRoom);
    rooms.delete(currentRoom.code);
  }, HOST_GRACE_MS);
}

function serializeBoard(room) {
  return BOARD.map((space) => {
    const ownerId = room.ownership[space.id] ?? null;
    const owner = room.players.find((player) => player.id === ownerId) ?? null;

    return {
      ...space,
      ownerId,
      ownerName: owner?.name ?? null
    };
  });
}

function ownedSpaceIdsForPlayer(room, playerId) {
  return Object.entries(room.ownership)
    .filter(([, ownerId]) => ownerId === playerId)
    .map(([spaceId]) => Number(spaceId));
}

function serializeRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    board: serializeBoard(room),
    hostConnected: room.host.connected,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      cash: player.cash,
      position: player.position,
      ready: player.ready,
      connected: player.connected,
      bankrupt: player.bankrupt,
      jailTurns: player.jailTurns,
      ownedSpaceIds: ownedSpaceIdsForPlayer(room, player.id),
      lastRoll: player.lastRoll
    })),
    pendingAction: room.pendingAction,
    turnPlayerId: room.turnPlayerId,
    turnDeadline: room.turnDeadline,
    turnMs: TURN_MS,
    lastEvent: room.lastEvent,
    winnerId: room.winnerId,
    log: room.log.slice(-12)
  };
}

function pushLog(room, message) {
  room.log.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message
  });
}

function send(socket, type, data = {}) {
  if (socket?.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type, ...data }));
  }
}

function broadcastRoom(room) {
  const payload = JSON.stringify({
    type: 'room_state',
    room: serializeRoom(room)
  });

  if (room.host.socket?.readyState === room.host.socket.OPEN) {
    room.host.socket.send(payload);
  }

  room.clients.forEach((client) => {
    if (client.socket?.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  });
}

function findRoomBySocket(socket) {
  for (const room of rooms.values()) {
    if (room.host.socket === socket) {
      return room;
    }

    if (room.clients.some((client) => client.socket === socket)) {
      return room;
    }
  }

  return null;
}

function getClientBySocket(room, socket) {
  return room.clients.find((client) => client.socket === socket) ?? null;
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  room.turnDeadline = null;
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);

  if (!room.turnPlayerId || room.phase === 'lobby' || room.phase === 'game_over') {
    return;
  }

  const expectedTurnId = room.turnPlayerId;
  const expectedPhase = room.phase;
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (
      !currentRoom ||
      currentRoom.turnPlayerId !== expectedTurnId ||
      currentRoom.phase !== expectedPhase
    ) {
      return;
    }

    const player = currentRoom.players.find((entry) => entry.id === expectedTurnId);
    if (!player || player.bankrupt) {
      return;
    }

    if (expectedPhase === 'rolling') {
      rollForPlayer(currentRoom, expectedTurnId, true);
      return;
    }

    if (expectedPhase === 'buying') {
      declinePurchase(currentRoom, expectedTurnId, true);
      return;
    }

    if (expectedPhase === 'resolving') {
      endTurn(currentRoom, expectedTurnId, true);
    }
  }, TURN_MS);
}

function solventPlayers(room) {
  return room.players.filter((player) => !player.bankrupt);
}

function maybeFinishGame(room) {
  const activePlayers = solventPlayers(room);

  if (activePlayers.length === 1) {
    const [winner] = activePlayers;
    room.phase = 'game_over';
    room.turnPlayerId = null;
    room.pendingAction = null;
    room.lastEvent = null;
    room.winnerId = winner.id;
    clearTurnTimer(room);
    pushLog(room, `${winner.name} won the game.`);
    broadcastRoom(room);
    return true;
  }

  return false;
}

function releaseProperties(room, playerId) {
  Object.entries(room.ownership).forEach(([spaceId, ownerId]) => {
    if (ownerId === playerId) {
      delete room.ownership[spaceId];
    }
  });
}

function bankruptPlayer(room, player, reason) {
  if (player.bankrupt) {
    return;
  }

  player.bankrupt = true;
  player.ready = false;
  player.lastRoll = null;
  releaseProperties(room, player.id);
  pushLog(room, reason);

  if (!maybeFinishGame(room) && room.turnPlayerId === player.id) {
    activateNextTurn(room);
  }
}

function applyCashDelta(room, player, amount, message) {
  player.cash += amount;
  if (message) {
    pushLog(room, message);
  }

  if (player.cash < 0) {
    bankruptPlayer(room, player, `${player.name} went bankrupt and their properties returned to the bank.`);
  }
}

function transferCash(room, fromPlayer, toPlayer, amount, message) {
  fromPlayer.cash -= amount;
  toPlayer.cash += amount;
  pushLog(room, message);

  if (fromPlayer.cash < 0) {
    bankruptPlayer(room, fromPlayer, `${fromPlayer.name} could not cover the payment and went bankrupt.`);
  }
}

function movePlayerBy(room, player, steps) {
  const nextPosition = player.position + steps;
  if (nextPosition >= BOARD.length) {
    player.cash += PASS_GO_BONUS;
    pushLog(room, `${player.name} passed GO and collected $${PASS_GO_BONUS}.`);
  }

  player.position = nextPosition % BOARD.length;
}

function movePlayerTo(room, player, position, awardPassGo) {
  if (awardPassGo && position < player.position) {
    player.cash += PASS_GO_BONUS;
    pushLog(room, `${player.name} passed GO and collected $${PASS_GO_BONUS}.`);
  }

  player.position = position;
}

function sendPlayerToJail(room, player, message) {
  player.position = JAIL_SPACE_ID;
  player.jailTurns = 1;
  pushLog(room, message);
}

function drawEventCard(deckName) {
  const deck = EVENT_CARDS[deckName] ?? EVENT_CARDS.chance;
  return deck[Math.floor(Math.random() * deck.length)];
}

function activateNextTurn(room) {
  clearTurnTimer(room);
  room.pendingAction = null;
  room.lastEvent = null;

  if (maybeFinishGame(room)) {
    return;
  }

  const totalPlayers = room.players.length;
  if (totalPlayers === 0) {
    room.phase = 'lobby';
    room.turnPlayerId = null;
    broadcastRoom(room);
    return;
  }

  let currentIndex = room.players.findIndex((player) => player.id === room.turnPlayerId);
  if (currentIndex < 0) {
    currentIndex = -1;
  }

  for (let checks = 0; checks < totalPlayers * 2; checks += 1) {
    currentIndex = (currentIndex + 1) % totalPlayers;
    const candidate = room.players[currentIndex];

    if (!candidate || candidate.bankrupt) {
      continue;
    }

    if (candidate.jailTurns > 0) {
      candidate.jailTurns -= 1;
      candidate.lastRoll = null;
      pushLog(room, `${candidate.name} is in jail and misses this turn.`);
      continue;
    }

    room.turnPlayerId = candidate.id;
    room.phase = 'rolling';
    candidate.lastRoll = null;
    pushLog(room, `${candidate.name}'s turn started.`);
    scheduleTurnTimer(room);
    broadcastRoom(room);
    return;
  }

  maybeFinishGame(room);
  broadcastRoom(room);
}

function finishResolution(room, player) {
  if (player.bankrupt || room.phase === 'game_over') {
    return;
  }

  room.phase = 'resolving';
  room.pendingAction = null;
  scheduleTurnTimer(room);
}

function resolveLanding(room, player, depth = 0) {
  if (player.bankrupt || room.phase === 'game_over') {
    return;
  }

  const space = BOARD[player.position];
  if (!space) {
    finishResolution(room, player);
    return;
  }

  if (space.type === 'property' || space.type === 'railroad' || space.type === 'utility') {
    const ownerId = room.ownership[space.id] ?? null;

    if (!ownerId) {
      if (player.cash >= space.cost) {
        room.phase = 'buying';
        room.pendingAction = {
          type: 'purchase_offer',
          spaceId: space.id,
          spaceName: space.name,
          cost: space.cost,
          rent: space.rent
        };
        pushLog(room, `${player.name} can buy ${space.name} for $${space.cost}.`);
        scheduleTurnTimer(room);
        return;
      }

      pushLog(room, `${player.name} cannot afford ${space.name}.`);
      finishResolution(room, player);
      return;
    }

    if (ownerId === player.id) {
      pushLog(room, `${player.name} landed on their own property.`);
      finishResolution(room, player);
      return;
    }

    const owner = room.players.find((entry) => entry.id === ownerId);
    if (!owner || owner.bankrupt) {
      delete room.ownership[space.id];
      finishResolution(room, player);
      return;
    }

    transferCash(
      room,
      player,
      owner,
      space.rent,
      `${player.name} paid $${space.rent} rent to ${owner.name} for ${space.name}.`
    );

    if (!player.bankrupt) {
      finishResolution(room, player);
    }

    return;
  }

  if (space.type === 'tax') {
    applyCashDelta(room, player, -space.amount, `${player.name} paid $${space.amount} in taxes.`);
    if (!player.bankrupt) {
      finishResolution(room, player);
    }
    return;
  }

  if (space.type === 'bonus') {
    applyCashDelta(room, player, space.amount, `${player.name} collected a $${space.amount} bonus.`);
    if (!player.bankrupt) {
      finishResolution(room, player);
    }
    return;
  }

  if (space.type === 'go_to_jail') {
    sendPlayerToJail(room, player, `${player.name} landed on Go To Jail.`);
    finishResolution(room, player);
    return;
  }

  if (space.type === 'event') {
    const card = drawEventCard(space.deck);
    room.lastEvent = {
      deck: space.deck,
      text: card.text,
      playerId: player.id
    };
    pushLog(room, `${player.name} drew: ${card.text}`);
    card.apply(room, player);

    if (!player.bankrupt && depth < 2 && player.position !== space.id) {
      resolveLanding(room, player, depth + 1);
      return;
    }

    if (!player.bankrupt) {
      finishResolution(room, player);
    }
    return;
  }

  if (space.type === 'jail') {
    pushLog(room, `${player.name} is just visiting jail.`);
  }

  finishResolution(room, player);
}

function startGame(room) {
  if (room.players.length < 2) {
    return { ok: false, message: 'Need at least 2 players to start.' };
  }

  const waitingPlayers = room.players.filter((player) => !player.ready);
  if (waitingPlayers.length > 0) {
    return { ok: false, message: 'All players must be ready before the game starts.' };
  }

  room.phase = 'rolling';
  room.turnPlayerId = null;
  room.winnerId = null;
  room.pendingAction = null;
  room.lastEvent = null;
  room.ownership = {};

  room.players.forEach((player) => {
    player.cash = STARTING_CASH;
    player.position = 0;
    player.ready = false;
    player.bankrupt = false;
    player.connected = room.clients.some((client) => client.playerId === player.id && client.socket);
    player.jailTurns = 0;
    player.lastRoll = null;
  });

  pushLog(room, 'Game started. Property ownership is now live.');
  activateNextTurn(room);
  return { ok: true };
}

function rollForPlayer(room, playerId, isAuto = false) {
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    return { ok: false, message: 'Player not found.' };
  }

  if (room.phase !== 'rolling') {
    return { ok: false, message: 'You cannot roll right now.' };
  }

  if (room.turnPlayerId !== playerId) {
    return { ok: false, message: 'It is not your turn.' };
  }

  if (player.lastRoll !== null) {
    return { ok: false, message: 'You already rolled this turn.' };
  }

  const roll = Math.floor(Math.random() * 6) + 1;
  player.lastRoll = roll;
  movePlayerBy(room, player, roll);
  const space = BOARD[player.position];
  pushLog(
    room,
    `${player.name} ${isAuto ? 'timed out and auto-rolled' : 'rolled'} ${roll} and landed on ${space.name}.`
  );
  resolveLanding(room, player);
  broadcastRoom(room);
  return { ok: true };
}

function buyProperty(room, playerId) {
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    return { ok: false, message: 'Player not found.' };
  }

  if (room.turnPlayerId !== playerId || room.phase !== 'buying') {
    return { ok: false, message: 'There is nothing to buy right now.' };
  }

  const pendingSpaceId = room.pendingAction?.spaceId;
  const space = BOARD.find((entry) => entry.id === pendingSpaceId);
  if (!space) {
    return { ok: false, message: 'Pending property not found.' };
  }

  if (room.ownership[space.id]) {
    return { ok: false, message: 'That property has already been claimed.' };
  }

  if (player.cash < space.cost) {
    return { ok: false, message: 'You cannot afford that property.' };
  }

  player.cash -= space.cost;
  room.ownership[space.id] = player.id;
  room.pendingAction = null;
  room.phase = 'resolving';
  pushLog(room, `${player.name} bought ${space.name} for $${space.cost}.`);
  scheduleTurnTimer(room);
  broadcastRoom(room);
  return { ok: true };
}

function declinePurchase(room, playerId, isAuto = false) {
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    return { ok: false, message: 'Player not found.' };
  }

  if (room.turnPlayerId !== playerId || room.phase !== 'buying') {
    return { ok: false, message: 'There is no purchase to skip.' };
  }

  const spaceName = room.pendingAction?.spaceName ?? 'that property';
  room.pendingAction = null;
  room.phase = 'resolving';
  pushLog(room, `${player.name} ${isAuto ? 'timed out and declined' : 'passed on'} ${spaceName}.`);
  scheduleTurnTimer(room);
  broadcastRoom(room);
  return { ok: true };
}

function endTurn(room, playerId, isAuto = false) {
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    return { ok: false, message: 'Player not found.' };
  }

  if (room.turnPlayerId !== playerId) {
    return { ok: false, message: 'It is not your turn.' };
  }

  if (room.phase === 'rolling') {
    return { ok: false, message: 'Roll before ending your turn.' };
  }

  if (room.phase === 'buying') {
    return { ok: false, message: 'Resolve the property choice first.' };
  }

  player.lastRoll = null;
  pushLog(room, `${player.name} ${isAuto ? 'timed out and ended' : 'ended'} their turn.`);
  activateNextTurn(room);
  return { ok: true };
}

function bindPlayerSocket(room, player, socket) {
  const existingIndex = room.clients.findIndex((client) => client.playerId === player.id);
  if (existingIndex >= 0) {
    const existingSocket = room.clients[existingIndex].socket;
    if (existingSocket && existingSocket !== socket) {
      existingSocket.close();
    }

    room.clients[existingIndex] = { playerId: player.id, socket };
  } else {
    room.clients.push({ playerId: player.id, socket });
  }

  player.connected = true;
}

function sendPlayerSession(socket, type, room, player) {
  send(socket, type, {
    playerId: player.id,
    reconnectToken: player.reconnectToken,
    room: serializeRoom(room)
  });
}

function sendHostSession(socket, type, room) {
  send(socket, type, {
    hostToken: room.host.reconnectToken,
    room: serializeRoom(room)
  });
}

const distRoot = resolve(fileURLToPath(new URL('../client/dist', import.meta.url)));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveFile(res, filePath) {
  const contentType = mimeTypes[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  const requestPath = req.url === '/' ? '/index.html' : req.url ?? '/index.html';

  if (!existsSync(distRoot)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Wolf of Boardwalk server is running. Build the client with "npm run build" to serve the app here.');
    return;
  }

  const assetPath = resolve(join(distRoot, requestPath.replace(/^\//, '')));
  if (assetPath.startsWith(distRoot) && existsSync(assetPath) && !assetPath.endsWith('/')) {
    serveFile(res, assetPath);
    return;
  }

  serveFile(res, join(distRoot, 'index.html'));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  const connectionId = randomUUID();

  socket.on('message', (buffer) => {
    let message;

    try {
      message = JSON.parse(buffer.toString());
    } catch {
      send(socket, 'error', { message: 'Invalid JSON message.' });
      return;
    }

    if (message.type === 'create_room') {
      const room = createRoom(socket);
      rooms.set(room.code, room);
      pushLog(room, 'Lobby created. Waiting for players.');
      sendHostSession(socket, 'room_created', room);
      broadcastRoom(room);
      return;
    }

    if (message.type === 'reconnect_host') {
      const room = rooms.get(String(message.code || '').toUpperCase());
      const token = String(message.hostToken || '');

      if (!room || token !== room.host.reconnectToken) {
        send(socket, 'error', { message: 'Host session not found.' });
        return;
      }

      clearRoomCleanup(room);
      room.host.socket = socket;
      room.host.connected = true;
      sendHostSession(socket, 'host_reconnected', room);
      pushLog(room, 'Host reconnected.');
      broadcastRoom(room);
      return;
    }

    if (message.type === 'join_room') {
      const room = rooms.get(String(message.code || '').toUpperCase());
      const name = String(message.name || '').trim().slice(0, 20);

      if (!room) {
        send(socket, 'error', { message: 'Room code not found.' });
        return;
      }

      if (room.phase !== 'lobby') {
        send(socket, 'error', { message: 'A game is already in progress. Use reconnect if you were already playing.' });
        return;
      }

      if (!name) {
        send(socket, 'error', { message: 'Name is required.' });
        return;
      }

      const player = createPlayer(connectionId, name);
      room.players.push(player);
      bindPlayerSocket(room, player, socket);
      pushLog(room, `${player.name} joined the lobby.`);
      sendPlayerSession(socket, 'joined_room', room, player);
      broadcastRoom(room);
      return;
    }

    if (message.type === 'reconnect_room') {
      const room = rooms.get(String(message.code || '').toUpperCase());
      const token = String(message.reconnectToken || '');
      const player = room?.players.find((entry) => entry.reconnectToken === token);

      if (!room || !player) {
        send(socket, 'error', { message: 'Player session not found.' });
        return;
      }

      bindPlayerSocket(room, player, socket);
      pushLog(room, `${player.name} reconnected.`);
      sendPlayerSession(socket, 'reconnected_room', room, player);
      broadcastRoom(room);
      return;
    }

    const room = findRoomBySocket(socket);

    if (!room) {
      send(socket, 'error', { message: 'Join or create a room first.' });
      return;
    }

    if (message.type === 'start_game') {
      if (room.host.socket !== socket) {
        send(socket, 'error', { message: 'Only the host can start the game.' });
        return;
      }

      const result = startGame(room);
      if (!result.ok) {
        send(socket, 'error', { message: result.message });
      }
      return;
    }

    if (message.type === 'toggle_ready') {
      if (room.phase !== 'lobby') {
        send(socket, 'error', { message: 'Ready state is only available in the lobby.' });
        return;
      }

      const client = getClientBySocket(room, socket);
      const player = room.players.find((entry) => entry.id === client?.playerId);

      if (!player) {
        send(socket, 'error', { message: 'Player not found.' });
        return;
      }

      player.ready = !player.ready;
      pushLog(room, `${player.name} is ${player.ready ? 'ready' : 'not ready'}.`);
      broadcastRoom(room);
      return;
    }

    if (message.type === 'roll') {
      const client = getClientBySocket(room, socket);
      const result = rollForPlayer(room, client?.playerId);
      if (!result.ok) {
        send(socket, 'error', { message: result.message });
      }
      return;
    }

    if (message.type === 'buy_property') {
      const client = getClientBySocket(room, socket);
      const result = buyProperty(room, client?.playerId);
      if (!result.ok) {
        send(socket, 'error', { message: result.message });
      }
      return;
    }

    if (message.type === 'skip_buy') {
      const client = getClientBySocket(room, socket);
      const result = declinePurchase(room, client?.playerId);
      if (!result.ok) {
        send(socket, 'error', { message: result.message });
      }
      return;
    }

    if (message.type === 'end_turn') {
      const client = getClientBySocket(room, socket);
      const result = endTurn(room, client?.playerId);
      if (!result.ok) {
        send(socket, 'error', { message: result.message });
      }
    }
  });

  socket.on('close', () => {
    const room = findRoomBySocket(socket);

    if (!room) {
      return;
    }

    if (room.host.socket === socket) {
      room.host.connected = false;
      room.host.socket = null;
      pushLog(room, 'Host disconnected. Waiting for reconnect.');
      scheduleRoomCleanup(room);
      broadcastRoom(room);
      return;
    }

    const clientIndex = room.clients.findIndex((entry) => entry.socket === socket);
    if (clientIndex >= 0) {
      const [{ playerId }] = room.clients.splice(clientIndex, 1);
      const player = room.players.find((entry) => entry.id === playerId);
      if (player) {
        player.connected = false;
        pushLog(room, `${player.name} disconnected.`);
      }

      broadcastRoom(room);
    }
  });

  send(socket, 'hello', { message: 'Connected to Wolf of Boardwalk server.' });
});

server.listen(PORT, () => {
  console.log(`Wolf of Boardwalk running on http://localhost:${PORT}`);
});
