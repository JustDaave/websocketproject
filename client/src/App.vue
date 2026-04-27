<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import HostDisplay from './components/HostDisplay.vue';
import PhoneController from './components/PhoneController.vue';

const ROUTES = {
  landing: '/',
  host: '/host',
  controller: '/controller'
};

const STORAGE_KEYS = {
  wsUrl: 'fast-pace-monopoly-ws-url',
  host: 'fast-pace-monopoly-host-session',
  controller: 'fast-pace-monopoly-controller-session'
};

const CONFIGURED_WS_URL = import.meta.env.VITE_WS_URL?.trim() || '';

const socket = ref(null);
const room = ref(null);
const playerId = ref('');
const status = ref('Disconnected');
const error = ref('');
const hostAccessCode = ref('');
const hostAccessError = ref('');
const wsUrl = ref(loadWsUrl());
const mode = ref(routeMode(window.location.pathname));

function defaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

  if (CONFIGURED_WS_URL) {
    return CONFIGURED_WS_URL;
  }

  if (isLocalHost(window.location.hostname)) {
    return `${protocol}://${window.location.hostname}:8080`;
  }

  return `${protocol}://${window.location.host}`;
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLegacyHostedDefault(value) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return value === `${protocol}://${window.location.hostname}:8080` && !isLocalHost(window.location.hostname);
}

function loadWsUrl() {
  const savedWsUrl = window.localStorage.getItem(STORAGE_KEYS.wsUrl);

  if (savedWsUrl && !(CONFIGURED_WS_URL && isLegacyHostedDefault(savedWsUrl))) {
    return savedWsUrl;
  }

  const nextDefault = defaultWsUrl();
  window.localStorage.setItem(STORAGE_KEYS.wsUrl, nextDefault);
  return nextDefault;
}

function routeMode(pathname) {
  if (pathname.startsWith(ROUTES.host)) {
    return 'host';
  }

  if (pathname.startsWith(ROUTES.controller)) {
    return 'controller';
  }

  return 'landing';
}

function readSession(key) {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

function writeSession(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function clearSession(key) {
  window.localStorage.removeItem(key);
}

function normalizedHostAccessCode() {
  return hostAccessCode.value.trim().toUpperCase();
}

function hasPendingHostAccessCode() {
  return Boolean(normalizedHostAccessCode());
}

function canResumeHostSession() {
  const savedHost = readSession(STORAGE_KEYS.host);
  return Boolean(savedHost?.code && savedHost?.hostToken);
}

function redirectHostToLanding(message) {
  hostAccessError.value = message || '';
  error.value = '';
  status.value = 'Disconnected';
  mode.value = 'landing';
  closeSocket();
  resetRoomState();

  if (window.location.pathname !== ROUTES.landing) {
    window.history.replaceState({}, '', ROUTES.landing);
  }
}

function closeSocket() {
  if (socket.value) {
    socket.value.close();
    socket.value = null;
  }
}

function send(payload, connection = socket.value) {
  if (connection?.readyState === WebSocket.OPEN) {
    connection.send(JSON.stringify(payload));
  }
}

function saveHostSession(nextRoom, hostToken) {
  if (!nextRoom?.code || !hostToken) {
    return;
  }

  writeSession(STORAGE_KEYS.host, {
    code: nextRoom.code,
    hostToken,
    wsUrl: wsUrl.value
  });
}

function saveControllerSession(nextRoom, reconnectToken, nextPlayerId) {
  if (!nextRoom?.code || !reconnectToken || !nextPlayerId) {
    return;
  }

  writeSession(STORAGE_KEYS.controller, {
    code: nextRoom.code,
    reconnectToken,
    playerId: nextPlayerId,
    wsUrl: wsUrl.value
  });
}

function resetRoomState() {
  room.value = null;
  playerId.value = '';
}

function connect(nextMode) {
  closeSocket();
  status.value = 'Connecting...';
  error.value = '';
  resetRoomState();

  if (!wsUrl.value) {
    status.value = 'Disconnected';
    error.value =
      'WebSocket URL is not configured. Set VITE_WS_URL for production deployments or run the Node server on the same origin.';
    return;
  }

  const connection = new WebSocket(wsUrl.value);
  socket.value = connection;

  connection.addEventListener('open', () => {
    if (socket.value !== connection) {
      return;
    }

    status.value = 'Connected';

    if (nextMode === 'host') {
      const savedHost = readSession(STORAGE_KEYS.host);
      if (savedHost?.code && savedHost?.hostToken) {
        send(
          {
            type: 'reconnect_host',
            code: savedHost.code,
            hostToken: savedHost.hostToken
          },
          connection
        );
        return;
      }

      send({ type: 'create_room', secretCode: normalizedHostAccessCode() }, connection);
      return;
    }

    if (nextMode === 'controller') {
      const savedController = readSession(STORAGE_KEYS.controller);
      if (savedController?.code && savedController?.reconnectToken) {
        send(
          {
            type: 'reconnect_room',
            code: savedController.code,
            reconnectToken: savedController.reconnectToken
          },
          connection
        );
      }
    }
  });

  connection.addEventListener('message', (event) => {
    if (socket.value !== connection) {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch {
      error.value = 'Received an invalid message from the server.';
      return;
    }

    if (payload.type === 'room_created' || payload.type === 'host_reconnected') {
      room.value = payload.room;
      playerId.value = '';
      saveHostSession(payload.room, payload.hostToken);
      return;
    }

    if (payload.type === 'joined_room' || payload.type === 'reconnected_room') {
      room.value = payload.room;
      playerId.value = payload.playerId;
      saveControllerSession(payload.room, payload.reconnectToken, payload.playerId);
      return;
    }

    if (payload.type === 'room_state') {
      room.value = payload.room;
      return;
    }

    if (payload.type === 'error') {
      error.value = payload.message;

      if (/session not found/i.test(payload.message)) {
        if (nextMode === 'host') {
          clearSession(STORAGE_KEYS.host);
        }

        if (nextMode === 'controller') {
          clearSession(STORAGE_KEYS.controller);
          playerId.value = '';
        }
      }

      if (nextMode === 'host' && /invalid host access code/i.test(payload.message)) {
        redirectHostToLanding(payload.message);
      }
    }
  });

  connection.addEventListener('close', () => {
    if (socket.value !== connection) {
      return;
    }

    socket.value = null;
    status.value = 'Disconnected';
  });

  connection.addEventListener('error', () => {
    if (socket.value !== connection) {
      return;
    }

    error.value =
      'WebSocket connection failed. On Vercel, set VITE_WS_URL to your deployed backend or host the Node server on a platform with persistent WebSocket support.';
  });
}

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }

  mode.value = routeMode(path);

  if (mode.value === 'landing') {
    closeSocket();
    resetRoomState();
    status.value = 'Disconnected';
    error.value = '';
    return;
  }

  connect(mode.value);
}

function createHost() {
  const requestedCode = window.prompt('Enter host access code');

  if (requestedCode === null) {
    return;
  }

  hostAccessCode.value = requestedCode;
  const normalizedCode = normalizedHostAccessCode();

  if (!normalizedCode) {
    hostAccessError.value = 'Enter the host access code to open the trading floor.';
    return;
  }

  hostAccessError.value = '';
  hostAccessCode.value = normalizedCode;
  clearSession(STORAGE_KEYS.host);
  navigate(ROUTES.host);
}

function connectController() {
  hostAccessError.value = '';
  navigate(ROUTES.controller);
}

function leaveSession() {
  if (mode.value === 'host') {
    clearSession(STORAGE_KEYS.host);
  }

  if (mode.value === 'controller') {
    clearSession(STORAGE_KEYS.controller);
  }

  navigate(ROUTES.landing);
}

function handlePopState() {
  const nextMode = routeMode(window.location.pathname);

  if (nextMode === 'host' && !canResumeHostSession() && !hasPendingHostAccessCode()) {
    redirectHostToLanding('Enter the host access code before opening the trading floor.');
    return;
  }

  mode.value = nextMode;

  if (nextMode === 'landing') {
    closeSocket();
    resetRoomState();
    status.value = 'Disconnected';
    error.value = '';
    return;
  }

  connect(nextMode);
}

const activePlayer = computed(() => room.value?.players?.find((player) => player.id === playerId.value) ?? null);
const winner = computed(() => room.value?.players?.find((player) => player.id === room.value?.winnerId) ?? null);

watch(wsUrl, (nextValue) => {
  window.localStorage.setItem(STORAGE_KEYS.wsUrl, nextValue);
});

watch(hostAccessCode, () => {
  hostAccessError.value = '';
});

watchEffect(() => {
  const viewLabel =
    mode.value === 'host' ? 'Trading Floor' : mode.value === 'controller' ? 'Trader Console' : 'Market Lobby';

  document.title = `Wolf of Boardwalk | ${viewLabel}`;
});

onMounted(() => {
  window.addEventListener('popstate', handlePopState);

  if (mode.value === 'host' && !canResumeHostSession() && !hasPendingHostAccessCode()) {
    redirectHostToLanding();
    return;
  }

  if (mode.value !== 'landing') {
    connect(mode.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', handlePopState);
  closeSocket();
});
</script>

<template>
  <main class="app-shell">
    <section v-if="mode === 'landing'" class="landing-panel panel">
      <p class="eyebrow">High-Stakes Boardroom Chaos</p>
      <h1>Wolf of Boardwalk</h1>
      <p class="lead">
        Run the board like a closing bell spectacle. One big screen commands the floor while every
        phone becomes a trader desk with reconnectable sessions, fast turns, market-swing event
        cards, and ruthless property takeovers.
      </p>

      <div class="hero-strip">
        <span class="hero-kicker">Luxury</span>
        <span class="hero-kicker">Pressure</span>
        <span class="hero-kicker">Boardwalk Power Plays</span>
      </div>

      <div class="route-preview">
        <span class="route-pill">/host Trading Floor</span>
        <span class="route-pill">/controller Trader Desk</span>
        <span class="route-pill">Refresh-safe reconnections</span>
      </div>

      <div class="actions">
        <button class="primary" @click="createHost">Host Game</button>
        <button class="secondary" @click="connectController">Join Game</button>
      </div>

      <p v-if="hostAccessError" class="host-access-error">{{ hostAccessError }}</p>

      <p class="market-note">
        Built for quick rounds, loud wins, and a room full of people trying to own the street.
      </p>
    </section>

    <section v-else class="session-shell">
      <header class="topbar panel">
        <div>
          <p class="eyebrow">{{ mode === 'host' ? 'Trading Floor' : 'Trader Console' }}</p>
          <strong>{{ status }}</strong>
        </div>
        <div class="topbar-actions">
          <span class="room-pill">{{ mode === 'host' ? '/host' : '/controller' }}</span>
          <span v-if="room" class="room-pill">Room {{ room.code }}</span>
          <button class="ghost" @click="leaveSession">Leave</button>
        </div>
      </header>

      <p v-if="error" class="error-banner">{{ error }}</p>
      <p v-if="winner" class="winner-banner panel">
        {{ winner.name }} now owns the street. Leave and open a new market to play again.
      </p>

      <HostDisplay
        v-if="mode === 'host'"
        :room="room"
        @start-game="send({ type: 'start_game' })"
      />

      <PhoneController
        v-else
        :room="room"
        :player="activePlayer"
        @join-room="send($event)"
        @roll="send({ type: 'roll' })"
        @buy-property="send({ type: 'buy_property' })"
        @skip-buy="send({ type: 'skip_buy' })"
        @end-turn="send({ type: 'end_turn' })"
      />
    </section>
  </main>
</template>
