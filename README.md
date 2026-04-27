# Wolf of Boardwalk Game

This is a real-time multiplayer board game with a luxury finance aesthetic inspired by high-pressure trading floors and boardwalk property wars.

## What This Base Includes

- A Node.js WebSocket server using the `ws` library.
- A Vue.js client using the browser's native `WebSocket` API.
- A host display route at `/host` for the shared trading floor screen.
- A phone controller route at `/controller` for trader actions.
- Room-code joining plus reconnect tokens so host and players can recover from refreshes.
- A larger Monopoly-style board with buyable properties, rent, taxes, jail, bonus spaces, and event cards.
- Timed turn phases: lobby, rolling, buying, resolving, and game over.


## Local Development

```bash
npm install
npm run dev
```

- Client: `http://localhost:5173`
- WebSocket server: `ws://localhost:8080`

For phone testing on the same network, open the client URL using your laptop's local IP address, then set the WebSocket URL on the landing screen to `ws://YOUR_LOCAL_IP:8080`.

## Production Build

```bash
npm run build
npm run start
```

After building, the Node server serves the compiled Vue app and the WebSocket endpoint from the same origin.

## Sample Flow

1. Open the app on the laptop and choose **Open Trading Floor**.
2. The host lands on `/host`, creates a room, and shows the desk code.
3. Each phone opens `/controller`, enters the code and name, and joins.
4. Players mark themselves ready in the lobby.
5. The host starts the match.
6. On each turn, the active player rolls, resolves events or payments, optionally buys property, and ends the turn before the timer expires.
7. Refreshing the host or phone route reconnects the saved session automatically.

## Current Gameplay Features

1. Larger 20-space Monopoly-inspired perimeter board.
2. Property ownership, buying, rent, taxes, and bankruptcy handling.
3. Turn timers with automatic roll, auto-decline purchase, and auto-end turn behavior.
4. Chance and Community Chest event cards.
5. Host and player reconnect tokens stored in the browser for refresh recovery.
6. Proper client routes for host and controller flows.
7. Production serving from the Node server after `npm run build`.

## Suggested Milestone Plan

### Milestone 1: Core Multiplayer Loop

- Keep the current room system.
- Add explicit game states such as lobby, rolling, buying, and resolving.
- Add server-side validation for every action.

### Milestone 2: Monopoly Mechanics

- Define the full board data model.
- Add ownership and transaction logic.
- Add jail, taxes, cards, and win conditions.

### Milestone 3: Fast-Paced Design

- Add countdown timers per turn.
- Limit decision windows on property purchase.
- Add stronger board feedback for the host screen.

### Milestone 4: Deployment

- Serve the built Vue app from Node or deploy client/server separately.
- Use a secure WebSocket connection in production.
- Test on real phones over the internet or on the same LAN.
