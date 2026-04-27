<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  room: {
    type: Object,
    default: null
  }
});

defineEmits(['start-game']);

const now = ref(Date.now());
let timerId = null;

const boardSideLength = computed(() => {
  const totalSpaces = props.room?.board?.length ?? 0;
  return totalSpaces > 0 ? Math.max(4, totalSpaces / 4 + 1) : 6;
});

const perimeterPositions = computed(() => {
  const size = boardSideLength.value;
  const positions = [];

  for (let column = size; column >= 1; column -= 1) {
    positions.push({ column, row: size });
  }

  for (let row = size - 1; row >= 1; row -= 1) {
    positions.push({ column: 1, row });
  }

  for (let column = 2; column <= size; column += 1) {
    positions.push({ column, row: 1 });
  }

  for (let row = 2; row <= size - 1; row += 1) {
    positions.push({ column: size, row });
  }

  return positions;
});

const turnPlayer = computed(() => props.room?.players?.find((player) => player.id === props.room?.turnPlayerId) ?? null);
const winner = computed(() => props.room?.players?.find((player) => player.id === props.room?.winnerId) ?? null);
const turnTimeRemaining = computed(() => {
  if (!props.room?.turnDeadline) {
    return 0;
  }

  return Math.max(0, Math.ceil((props.room.turnDeadline - now.value) / 1000));
});

function occupantNames(spaceId) {
  if (!props.room?.players?.length) {
    return [];
  }

  return props.room.players
    .filter((player) => !player.bankrupt && player.position === spaceId)
    .map((player) => player.name);
}

function boardCellStyle(index) {
  const position = perimeterPositions.value[index];

  if (!position) {
    return {};
  }

  return {
    gridColumn: String(position.column),
    gridRow: String(position.row)
  };
}

function boardStyle() {
  return {
    gridTemplateColumns: `repeat(${boardSideLength.value}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${boardSideLength.value}, minmax(120px, 1fr))`
  };
}

function centerStyle() {
  return {
    gridColumn: `2 / span ${boardSideLength.value - 2}`,
    gridRow: `2 / span ${boardSideLength.value - 2}`
  };
}

function spaceMeta(space) {
  if (space.type === 'property' || space.type === 'railroad' || space.type === 'utility') {
    return `$${space.cost} • Rent $${space.rent}`;
  }

  if (space.type === 'tax') {
    return `Pay $${space.amount}`;
  }

  if (space.type === 'bonus') {
    return `Collect $${space.amount}`;
  }

  if (space.description) {
    return space.description;
  }

  return space.type.replaceAll('_', ' ');
}

onMounted(() => {
  timerId = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  window.clearInterval(timerId);
});
</script>

<template>
  <section class="host-layout">
    <div class="board-panel panel">
      <div class="board-head">
        <div>
          <p class="eyebrow">Trading Floor</p>
          <h2>Boardwalk Exchange</h2>
        </div>
        <button class="primary" :disabled="!room || room.phase !== 'lobby'" @click="$emit('start-game')">
          {{ room?.phase === 'lobby' ? 'Ring Opening Bell' : 'Market Running' }}
        </button>
      </div>

      <div v-if="room" class="board-grid monopoly-grid" :style="boardStyle()">
        <article
          v-for="(space, index) in room.board"
          :key="space.id"
          :class="['space-card', `space-${space.type}`, { owned: Boolean(space.ownerId), active: room.turnPlayerId && occupantNames(space.id).length }]"
          :style="boardCellStyle(index)"
        >
          <p class="space-index">{{ space.id }}</p>
          <h3>{{ space.name }}</h3>
          <p class="space-type">{{ spaceMeta(space) }}</p>
          <p v-if="space.ownerName" class="space-owner">Owned by {{ space.ownerName }}</p>
          <div class="tokens">
            <span v-for="name in occupantNames(space.id)" :key="name" class="token">
              {{ name.slice(0, 2).toUpperCase() }}
            </span>
          </div>
        </article>

        <div class="board-center panel" :style="centerStyle()">
          <p class="eyebrow">Wolf of Boardwalk</p>
          <h3>{{ room.code }}</h3>
          <p v-if="winner">Street Owner: {{ winner.name }}</p>
          <p v-else-if="turnPlayer">
            {{ turnPlayer.name }} is in {{ room.phase }}
            <span v-if="turnTimeRemaining"> • {{ turnTimeRemaining }}s left</span>
          </p>
          <p v-else>Ring the bell to flood the board with traders.</p>
          <div v-if="room.pendingAction" class="center-note">
            <strong>{{ room.pendingAction.spaceName }}</strong>
            <span>${{ room.pendingAction.cost }} to acquire</span>
          </div>
          <div v-if="room.lastEvent" class="event-card-preview">
            <span class="event-label">{{ room.lastEvent.deck }}</span>
            <strong>{{ room.lastEvent.text }}</strong>
          </div>
        </div>
      </div>

      <div v-else class="empty-state">
        <h3>Creating lobby...</h3>
        <p>The room code will appear here once the socket connects.</p>
      </div>
    </div>

    <aside class="side-panel">
      <section class="panel room-summary" v-if="room">
        <p class="eyebrow">Desk Code</p>
        <div class="room-code">{{ room.code }}</div>
        <p>Players join from /controller and can reclaim their desk after a refresh.</p>
      </section>

      <section class="panel">
        <div class="section-head">
          <h3>Players</h3>
          <span>{{ room?.players?.length ?? 0 }}</span>
        </div>
        <ul class="player-list">
          <li v-for="player in room?.players ?? []" :key="player.id">
            <div>
              <strong>{{ player.name }}</strong>
              <p>
                ${{ player.cash }} • {{ player.ownedSpaceIds.length }} properties •
                {{ room?.board?.[player.position]?.name ?? `Space ${player.position}` }}
              </p>
            </div>
            <span :class="['status-chip', { active: room?.turnPlayerId === player.id, offline: !player.connected, bankrupt: player.bankrupt }]">
              {{ player.bankrupt ? 'Bankrupt' : room?.turnPlayerId === player.id ? 'Turn' : player.ready ? 'Ready' : player.connected ? 'Waiting' : 'Offline' }}
            </span>
          </li>
        </ul>
      </section>

      <section class="panel" v-if="room">
        <div class="section-head">
          <h3>Market State</h3>
          <span>{{ room.phase }}</span>
        </div>
        <p v-if="turnPlayer">
          {{ turnPlayer.name }} has {{ turnTimeRemaining }} second{{ turnTimeRemaining === 1 ? '' : 's' }} remaining.
        </p>
        <p v-else>The floor is waiting for the opening bell.</p>
        <p v-if="room.pendingAction">Pending acquisition: {{ room.pendingAction.spaceName }}</p>
      </section>

      <section class="panel">
        <h3>Ticker Feed</h3>
        <ul class="log-list">
          <li v-for="entry in room?.log ?? []" :key="entry.id">{{ entry.message }}</li>
        </ul>
      </section>
    </aside>
  </section>
</template>
