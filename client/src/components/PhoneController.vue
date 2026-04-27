<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  room: {
    type: Object,
    default: null
  },
  player: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['join-room', 'toggle-ready', 'roll', 'buy-property', 'skip-buy', 'end-turn']);

const code = ref('');
const name = ref('');
const now = ref(Date.now());
let timerId = null;

const canJoin = computed(() => code.value.trim() && name.value.trim());
const isMyTurn = computed(() => props.room?.turnPlayerId === props.player?.id);
const isRolling = computed(() => props.room?.phase === 'rolling');
const isBuying = computed(() => props.room?.phase === 'buying');
const isResolving = computed(() => props.room?.phase === 'resolving');
const winner = computed(() => props.room?.players?.find((entry) => entry.id === props.room?.winnerId) ?? null);
const currentSpace = computed(() => props.room?.board?.[props.player?.position] ?? null);
const pendingAction = computed(() => props.room?.pendingAction ?? null);
const ownedProperties = computed(() => {
  if (!props.room?.board || !props.player?.ownedSpaceIds?.length) {
    return [];
  }

  return props.room.board.filter((space) => props.player.ownedSpaceIds.includes(space.id));
});
const timeRemaining = computed(() => {
  if (!props.room?.turnDeadline) {
    return 0;
  }

  return Math.max(0, Math.ceil((props.room.turnDeadline - now.value) / 1000));
});
const statusText = computed(() => {
  if (winner.value) {
    return winner.value.id === props.player?.id ? 'You own the street.' : `${winner.value.name} owns the street.`;
  }

  if (props.player?.bankrupt) {
    return 'You are tapped out and out of the rotation.';
  }

  if (isMyTurn.value && isRolling.value) {
    return 'Your turn is live. Make the move before the bell hits zero.';
  }

  if (isMyTurn.value && isBuying.value) {
    return 'Decide whether this asset belongs in your portfolio.';
  }

  if (isMyTurn.value && isResolving.value) {
    return 'Your play is settled. Close the turn and pass control.';
  }

  if (props.room?.phase === 'lobby') {
    return 'Signal that you are ready and wait for the opening bell.';
  }

  return 'Hold position until the market rotates back to you.';
});

function joinRoom() {
  emit('join-room', {
    type: 'join_room',
    code: code.value.trim().toUpperCase(),
    name: name.value.trim()
  });
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
  <section class="controller-shell">
    <div v-if="!player" class="panel controller-panel join-panel">
      <p class="eyebrow">Trader Console</p>
      <h2>Claim Your Desk</h2>
      <label class="field">
        <span>Desk Code</span>
        <input v-model="code" maxlength="5" placeholder="A1B2C" />
      </label>
      <label class="field">
        <span>Trader Name</span>
        <input v-model="name" maxlength="20" placeholder="Wolf alias" />
      </label>
      <button class="primary" :disabled="!canJoin" @click="joinRoom">Enter The Market</button>
    </div>

    <div v-else class="controller-stack">
      <section class="panel controller-panel identity-panel">
        <p class="eyebrow">Trader Online</p>
        <h2>{{ player.name }}</h2>
        <p>Cash: ${{ player.cash }}</p>
        <p>Current asset: {{ currentSpace?.name ?? 'Unknown' }}</p>
        <p v-if="player.jailTurns > 0">Lockup turns remaining: {{ player.jailTurns }}</p>
      </section>

      <section class="panel controller-panel" v-if="room?.phase === 'lobby'">
        <div class="section-head">
          <h3>Desk Actions</h3>
          <span>{{ room?.phase }}</span>
        </div>
        <button class="secondary" @click="$emit('toggle-ready')">
          {{ player.ready ? 'Stand Down' : 'Signal Ready' }}
        </button>
      </section>

      <section class="panel controller-panel action-grid">
        <button class="primary big-button" :disabled="!isMyTurn || !isRolling || player.lastRoll !== null || player.bankrupt" @click="$emit('roll')">
          Roll The Dice
        </button>
        <button class="primary big-button accent" :disabled="!isMyTurn || !isBuying || player.bankrupt" @click="$emit('buy-property')">
          Acquire Asset
        </button>
        <button class="secondary big-button" :disabled="!isMyTurn || !isBuying || player.bankrupt" @click="$emit('skip-buy')">
          Pass Deal
        </button>
        <button class="secondary big-button" :disabled="!isMyTurn || !isResolving || player.bankrupt" @click="$emit('end-turn')">
          Close Turn
        </button>
      </section>

      <section class="panel controller-panel">
        <div class="section-head">
          <h3>Market Status</h3>
          <span>{{ isMyTurn ? `${timeRemaining}s` : 'Waiting' }}</span>
        </div>
        <p>{{ statusText }}</p>
        <p v-if="pendingAction && isMyTurn">
          {{ pendingAction.spaceName }} costs ${{ pendingAction.cost }} and yields ${{ pendingAction.rent }} rent.
        </p>
      </section>

      <section class="panel controller-panel" v-if="room?.lastEvent">
        <div class="section-head">
          <h3>{{ room.lastEvent.deck }}</h3>
          <span>Event</span>
        </div>
        <p>{{ room.lastEvent.text }}</p>
      </section>

      <section class="panel controller-panel">
        <div class="section-head">
          <h3>Your Holdings</h3>
          <span>{{ ownedProperties.length }}</span>
        </div>
        <ul v-if="ownedProperties.length" class="owned-list">
          <li v-for="space in ownedProperties" :key="space.id">
            <strong>{{ space.name }}</strong>
            <span>${{ space.rent }} rent</span>
          </li>
        </ul>
        <p v-else>No assets acquired yet.</p>
      </section>
    </div>
  </section>
</template>
