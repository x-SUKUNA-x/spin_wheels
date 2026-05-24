# Spin Wheel Game — Backend
Real-time multiplayer spin wheel game backend powered by Node.js, Socket.io, and PostgreSQL.

## Overview
The Spin Wheel Game is a real-time multiplayer game where users pay a coin-based entry fee to join a spinning wheel. It features an elimination-style game mechanic where participants are dropped one by one until a single winner remains. The winner takes a calculated percentage of the total pool, while the rest is divided between admin and platform pools.

## Features

- **User Authentication**: Secure JWT-based authentication with Refresh Token rotation.
- **Role-Based Access**: Granular control separating `user` and `admin` capabilities.
- **Spin Wheel Lifecycle**: Admin-driven wheel creation with provably fair cryptographic seeds.
- **Real-Time Updates**: Socket.io integration via Redis Pub/Sub for synchronized game state.
- **Distributed Job Processing**: Crash-safe background game state execution using BullMQ.
- **Wallet & Transactions**: Robust coin accounting with row-level locked PostgreSQL transactions.
- **Observability**: Prometheus metrics (`/metrics`), health checks (`/health`), and Winston request tracing.
- **Containerized**: Production-ready `docker-compose` setup for horizontal scaling.

## Architecture
The system utilizes a multi-layered architecture:
- **HTTP**: Express routes handle request parsing and pass data to controllers, which use services to interact with PostgreSQL.
- **Real-time**: Socket.io operates on the same HTTP server, utilizing JWT-authenticated connections to push game state and events.
- **Game engine**: An in-memory state machine (`elimination.service.js`) handles the countdown and participant elimination, with the database acting as the ultimate source of truth.
- **Coin ops**: All coin modifications are executed using atomic database transactions with `FOR UPDATE` row locks to prevent race conditions.

## Tech Stack
- Node.js 18+
- Express
- PostgreSQL
- Socket.io
- JWT (jsonwebtoken)
- bcryptjs
- pg

## Prerequisites
- Node.js 18+
- PostgreSQL database (local or cloud — we use Neon.tech)

## Setup
```bash
git clone <your-repo-url>
cd spinwheel-backend
npm install
cp .env.example .env
# Edit .env with your values
npm run migrate
npm run dev
```

## Environment Variables

| Variable | Description | Example |
| -------- | ----------- | ------- |
| `PORT` | The port for the server to listen on | `3000` |
| `NODE_ENV` | Environment mode | `development` |
| `DB_HOST` | PostgreSQL database host | `your_db_host` |
| `DB_PORT` | PostgreSQL database port | `5432` |
| `DB_USER` | PostgreSQL database user | `your_db_user` |
| `DB_PASSWORD` | PostgreSQL database password | `your_db_password` |
| `DB_NAME` | PostgreSQL database name | `spinwheel_db` |
| `DB_SSL` | Enable SSL for PostgreSQL | `false` |
| `JWT_SECRET` | Secret key for JWT signing | `replace_with_64_char_random_hex_string` |
| `JWT_EXPIRES_IN` | JWT expiration duration | `7d` |
| `CLIENT_URL` | Allowed client URL for CORS | `http://localhost:3000` |

*(Note: There are 11 variables in the current `.env.example`, the list above reflects them.)*

## API Reference

| Method | Path | Auth | Role | Description |
| ------ | ---- | ---- | ---- | ----------- |
| POST | `/api/auth/register` | No | Any | Register a new user account |
| POST | `/api/auth/login` | No | Any | Authenticate and receive a JWT |
| GET | `/api/auth/me` | Yes | Any | Get current authenticated user details |
| POST | `/api/wheels` | Yes | Admin | Create a new spin wheel |
| POST | `/api/wheels/:wheelId/join` | Yes | Any | Join an active spin wheel and pay entry fee |
| POST | `/api/wheels/:wheelId/start` | Yes | Admin | Start the spin wheel game |
| GET | `/api/wheels` | Yes | Any | Get a list of active spin wheels |
| GET | `/api/admin/config` | Yes | Admin | Retrieve the current global game configuration |
| PATCH | `/api/admin/config` | Yes | Admin | Update the global game configuration |
| GET | `/api/admin/wheels` | Yes | Admin | List all wheels (paginated) |
| GET | `/api/admin/wheels/:wheelId` | Yes | Admin | Get details of a specific wheel, including participants and transactions |
| GET | `/api/admin/users` | Yes | Admin | List all users (paginated) |
| POST | `/api/admin/users/:userId/coins` | Yes | Admin | Credit or debit coins for a specific user |
| GET | `/api/transactions/me` | Yes | Any | List current user's transactions (paginated) |
| GET | `/api/transactions/wheel/:wheelId` | Yes | Any | List all transactions for a specific wheel |

## Socket.io Events

### Server → Client

| Event | Description |
| ----- | ----------- |
| `wheel:created` | Broadcast globally when a new wheel is created |
| `wheel:new_active` | Broadcast to all clients when a wheel becomes active |
| `wheel:room_joined` | Sent to the joining client confirming they entered the room |
| `wheel:participant_joined` | Broadcast to the room when someone joins |
| `wheel:started` | Broadcast to the room when the wheel starts spinning |
| `wheel:elimination` | Broadcast to the room when a participant is eliminated |
| `wheel:you_were_eliminated` | Sent privately to the user who was eliminated |
| `wheel:completed` | Broadcast to the room when the wheel finishes |
| `wheel:you_won` | Sent privately to the user who won |
| `wheel:state` | Sent to the client in response to `wheel:get_state` |
| `error` | Sent privately for game-level errors |
| `connect_error` | Standard Socket.io connection error event |

### Client → Server

| Event | Description |
| ----- | ----------- |
| `wheel:join_room` | Request to join a specific wheel's Socket room |
| `wheel:leave_room` | Request to leave a specific wheel's Socket room |
| `wheel:get_state` | Request the current state of a specific wheel |

## Game Flow

1. Admin creates a new spin wheel using the `POST /api/wheels` endpoint.
2. The server creates the wheel in the database, locking in a snapshot of the current configuration (entry fee, pool percentages), and broadcasts `wheel:created`.
3. Users join the wheel via `POST /api/wheels/:wheelId/join`, which atomically deducts the entry fee from their balance and adds them as a participant.
4. Server broadcasts `wheel:participant_joined` to clients in the room after each successful join.
5. Once `min_participants` is reached, Admin starts the game via `POST /api/wheels/:wheelId/start`.
6. Server marks the wheel as 'spinning' and begins the elimination timer, broadcasting `wheel:started`.
7. Every `elimination_interval_seconds`, the server selects a random participant to eliminate, broadcasting `wheel:elimination` and `wheel:you_were_eliminated`.
8. Once only one participant remains, the server awards them the winner pool, updates the database, and broadcasts `wheel:completed` and `wheel:you_won`.

## Coin Distribution

The total entry fees collected from all participants make up the pot, which is distributed into three pools based on the configuration snapshot taken when the wheel was created.

* **Entry fee:** 10 coins
* **Winner pool (70%):** 7 coins per entry
* **Admin pool (20%):** 2 coins per entry
* **App pool (10%):** 1 coin per entry

With 5 players, the total pot is 50 coins. The winner gets 35 coins, the admin who created the wheel gets 10 coins, and the remaining 5 coins go to the app pool.

## Running Tests

```bash
npm run verify
npm run test:auth
npm run test:phase4
npm run test:phase5
npm run test:phase6
npm run test:phase7
```

## Edge Cases Handled

1. **Only one active wheel at a time** — enforced at service layer before insert
2. **User joining same wheel twice** — unique constraint in DB + service-layer check
3. **Insufficient coin balance** — FOR UPDATE lock prevents race condition, throws before debit
4. **Auto-abort when < 3 participants after timeout** — timer fires abortWheel, all entry fees refunded atomically
5. **Manual abort mid-game** — status guard prevents double-refund if abort called twice concurrently
6. **Double-payout prevention** — finalizeWinner checks status === 'spinning' before any credits
7. **Config changes don't affect active wheels** — snapshots copied to spin_wheels at creation time
8. **Timer memory leaks** — cleanupTimers() called at every terminal state (completed/aborted)
9. **Unauthenticated socket connections** — JWT middleware on io.use() rejects before connection
10. **Socket errors never crash the game loop** — all emissions are fire-and-forget with try/catch
11. **Concurrent coin updates** — SELECT ... FOR UPDATE row-level lock serializes balance mutations
12. **Admin role verified from DB** — not just from JWT payload, re-fetched on sensitive operations

## Assumptions

- One active wheel at a time is a business rule, not a technical limitation
- App pool coins are tracked in DB but not credited to any user — they represent platform revenue
- Admin who creates the wheel receives the admin pool payout
- Minimum 3 participants is configurable via the admin config API
- Socket connections require a valid JWT — no anonymous spectators
