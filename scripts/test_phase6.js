'use strict';
/**
 * scripts/test_phase6.js
 * ----------------------
 * End-to-end integration test for Phase 6: socket emission helpers.
 *
 * Run: npm run dev (Terminal 1)  →  npm run test:phase6 (Terminal 2)
 *
 * Tests covered:
 *  1-2   Register 1 admin + 3 users, save tokens/userIds
 *  3     Credit each of the 3 users with 100 coins
 *  4     Connect 4 Socket.io clients (admin + 3 users) with valid tokens
 *  5     Confirm all 4 connect successfully
 *  6     Connect a 5th client with an invalid token — confirm connection error
 *  7-9   All 4 clients listen for wheel:created, admin creates wheel via HTTP
 *  10    Confirm all 4 received wheel:created with correct wheelId + entryFee
 *  11    All 3 user clients send wheel:join_room and confirm wheel:room_joined
 *  12-14 Users listen for wheel:participant_joined, users join via HTTP, confirm events
 *  15-17 Clients listen for wheel:started, admin starts wheel, confirm event
 *  18-20 Listen for wheel:elimination (2×) and wheel:you_were_eliminated (personal)
 *  21-22 Confirm wheel:completed (room) and wheel:you_won (personal winner)
 *  23    Verify winner balance in DB
 *  24-25 Send wheel:get_state, confirm wheel:state response
 *  26    Disconnect all clients cleanly
 *  27    Delete all test data from DB
 *  28    Print full summary (passed / failed count)
 *
 * Exits 0 if all pass, 1 if any fail.
 */

require('dotenv').config();

const { io: ioClient } = require('socket.io-client');
const { pool }         = require('../src/config/db');
const { creditCoins }  = require('../src/services/coin.service');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Game config — fetched from DB at runtime
let ENTRY_FEE, WINNER_PCT, ADMIN_PCT, ELIM_INTERVAL_SECS, MIN_PARTICIPANTS;

// ── Test accounts ─────────────────────────────────────────────────────────────

const ADMIN_CREDS = { username: 'p6_admin', email: 'p6_admin@test.com', password: 'Admin1234!', role: 'admin' };
const USER_CREDS  = [
  { username: 'p6_user1', email: 'p6_user1@test.com', password: 'User1234!', role: 'user' },
  { username: 'p6_user2', email: 'p6_user2@test.com', password: 'User1234!', role: 'user' },
  { username: 'p6_user3', email: 'p6_user3@test.com', password: 'User1234!', role: 'user' },
];

// ── State ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

let adminToken  = null;
let adminUserId = null;
const userTokens = [];
const userIds    = [];
const allUserIds  = [];   // for cleanup
const allWheelIds = [];   // for cleanup

/** All open socket clients — disconnected in finally block */
const allSockets = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

function pass(name, detail = '') {
  console.log(`  ✅  ${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
}

function fail(name, detail = '') {
  console.error(`  ❌  ${name}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

function check(name, ok, detail = '') {
  ok ? pass(name, detail) : fail(name, detail);
}

/** HTTP helper */
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

/**
 * Wait for a single socket event.
 * Resolves with the event payload or rejects after timeoutMs.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<any>}
 */
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for "${event}" on socket ${socket.id}`));
    }, timeoutMs);

    function handler(data) {
      clearTimeout(timer);
      resolve(data);
    }

    socket.once(event, handler);
  });
}

/**
 * Wait for N occurrences of a socket event.
 * Resolves with an array of N payloads or rejects after timeoutMs.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {number} count
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<any[]>}
 */
function waitForEvents(socket, event, count, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payloads = [];

    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(
        `Timeout (${timeoutMs}ms) waiting for ${count}× "${event}" — got ${payloads.length}`,
      ));
    }, timeoutMs);

    function handler(data) {
      payloads.push(data);
      if (payloads.length >= count) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payloads);
      }
    }

    socket.on(event, handler);
  });
}

/**
 * Create and connect a Socket.io client.
 * Registers it in allSockets so the finally block cleans it up.
 *
 * @param {string|null} token  — pass null or 'bad.token.here' to test auth rejection
 * @returns {import('socket.io-client').Socket}
 */
function createClient(token) {
  const socket = ioClient(BASE_URL, {
    auth: token ? { token } : {},
    reconnection: false,
    transports: ['websocket'],
  });
  allSockets.push(socket);
  return socket;
}

/**
 * Wait for a socket to emit 'connect' or reject on 'connect_error'.
 * @param {import('socket.io-client').Socket} socket
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<void>}
 */
function waitForConnect(socket, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });

    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getUserBalance(userId) {
  const r = await pool.query('SELECT coin_balance FROM users WHERE id = $1', [userId]);
  return r.rows.length ? parseFloat(r.rows[0].coin_balance) : null;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  // Read live config so we never hardcode numbers
  const configRes = await pool.query('SELECT * FROM spin_wheel_config LIMIT 1');
  if (configRes.rows.length === 0) throw new Error('spin_wheel_config table is empty');
  const config = configRes.rows[0];
  ENTRY_FEE          = parseFloat(config.entry_fee);
  WINNER_PCT         = parseFloat(config.winner_pool_percent);
  ADMIN_PCT          = parseFloat(config.admin_pool_percent);
  ELIM_INTERVAL_SECS = parseInt(config.elimination_interval_seconds, 10);
  MIN_PARTICIPANTS   = parseInt(config.min_participants, 10);

  console.log(
    `  ℹ️  Config: entryFee=${ENTRY_FEE}, elimInterval=${ELIM_INTERVAL_SECS}s, ` +
    `winnerPct=${WINNER_PCT}%, adminPct=${ADMIN_PCT}%, minParticipants=${MIN_PARTICIPANTS}`,
  );

  section('Setup — register accounts');

  // Register admin
  {
    const { status, data } = await req('POST', '/api/auth/register', { body: ADMIN_CREDS });
    check('Register admin', status === 201 && !!data?.data?.token, `status=${status}`);
    if (data?.data?.token) {
      adminToken  = data.data.token;
      adminUserId = data.data.user.id;
      allUserIds.push(adminUserId);
    }
  }

  // Register 3 users
  for (let i = 0; i < USER_CREDS.length; i++) {
    const { status, data } = await req('POST', '/api/auth/register', { body: USER_CREDS[i] });
    check(`Register user${i + 1}`, status === 201 && !!data?.data?.token, `status=${status}`);
    if (data?.data?.token) {
      userTokens.push(data.data.token);
      userIds.push(data.data.user.id);
      allUserIds.push(data.data.user.id);
    }
  }

  section('Setup — credit 100 coins to each user');
  for (let i = 0; i < userIds.length; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { newBalance } = await creditCoins(
        client, userIds[i], 100.00, null, 'admin_credit', 'Phase 6 test setup',
      );
      await client.query('COMMIT');
      check(`Credit 100 → user${i + 1}`, newBalance === 100, `balance=${newBalance}`);
    } catch (err) {
      await client.query('ROLLBACK');
      fail(`Credit 100 → user${i + 1}`, err.message);
    } finally {
      client.release();
    }
  }
}

// ── Socket connection tests ───────────────────────────────────────────────────

async function testSocketConnections() {
  section('Socket connections — valid + invalid tokens');

  // Create clients for admin + 3 users
  const adminSocket  = createClient(adminToken);
  const userSockets  = userTokens.map((t) => createClient(t));

  // Test: all 4 connect successfully
  try {
    await Promise.all([
      waitForConnect(adminSocket),
      ...userSockets.map((s) => waitForConnect(s)),
    ]);
    pass('All 4 clients connected successfully');
  } catch (err) {
    fail('All 4 clients connected successfully', err.message);
  }

  // Test: 5th client with bad token gets a connection error
  {
    const badSocket = ioClient(BASE_URL, {
      auth: { token: 'bad.token.here' },
      reconnection: false,
      transports: ['websocket'],
    });

    try {
      await waitForConnect(badSocket, 6000);
      fail('Bad-token client rejected', 'it connected — should have been rejected');
    } catch (err) {
      pass('Bad-token client rejected', `error="${err.message}"`);
    } finally {
      badSocket.disconnect();
    }
  }

  return { adminSocket, userSockets };
}

// ── Main game flow ────────────────────────────────────────────────────────────

async function testGameFlow(adminSocket, userSockets) {
  let wheelId = null;

  // ── wheel:created ────────────────────────────────────────────────────────────
  section('wheel:created — broadcast to all on wheel creation');

  // All 4 clients start listening before the HTTP call
  const createdListeners = [adminSocket, ...userSockets].map((s) =>
    waitForEvent(s, 'wheel:created', 8000),
  );

  // Admin creates wheel via HTTP
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    check('Admin creates wheel → 201', status === 201 && !!data?.data?.wheel?.id, `status=${status}`);
    if (data?.data?.wheel?.id) {
      wheelId = data.data.wheel.id;
      allWheelIds.push(wheelId);
    } else {
      fail('Wheel creation failed — aborting game flow tests');
      return;
    }
  }

  // Confirm all 4 received wheel:created
  try {
    const results = await Promise.all(createdListeners);
    const allCorrect = results.every(
      (r) => r.wheelId === wheelId && parseFloat(r.entryFee) === ENTRY_FEE,
    );
    check(
      'All 4 clients received wheel:created with correct payload',
      allCorrect,
      `payloads=${JSON.stringify(results.map((r) => ({ wheelId: r.wheelId, entryFee: r.entryFee })))}`,
    );
  } catch (err) {
    fail('All 4 clients received wheel:created', err.message);
  }

  // ── wheel:join_room + wheel:room_joined ───────────────────────────────────────
  section('wheel:join_room — clients join the wheel room');

  const roomJoinedPromises = userSockets.map((s) => waitForEvent(s, 'wheel:room_joined', 5000));
  userSockets.forEach((s) => s.emit('wheel:join_room', { wheelId }));

  try {
    const results = await Promise.all(roomJoinedPromises);
    const allCorrect = results.every((r) => r.wheelId === wheelId);
    check('All 3 user clients received wheel:room_joined', allCorrect, `wheelId=${wheelId}`);
  } catch (err) {
    fail('All 3 user clients received wheel:room_joined', err.message);
  }

  // Also put admin in room so it receives room-scoped events
  adminSocket.emit('wheel:join_room', { wheelId });
  await waitForEvent(adminSocket, 'wheel:room_joined', 5000).catch(() => {});

  // ── wheel:participant_joined ──────────────────────────────────────────────────
  section('wheel:participant_joined — emitted after each HTTP join');

  // Track how many participant_joined events each room member gets
  const participantJoinedCounts = [0, 0, 0]; // per user socket
  userSockets.forEach((s, i) => {
    s.on('wheel:participant_joined', () => { participantJoinedCounts[i]++; });
  });

  // Each user joins via HTTP sequentially so we can assert per-join event
  for (let i = 0; i < userIds.length; i++) {
    // Listen for the event from any room member BEFORE making the HTTP call
    const eventPromise = waitForEvent(userSockets[0], 'wheel:participant_joined', 6000);
    const { status } = await req('POST', `/api/wheels/${wheelId}/join`, { token: userTokens[i] });
    check(`User ${i + 1} joins wheel via HTTP → 200`, status === 200, `status=${status}`);
    try {
      const ev = await eventPromise;
      check(
        `wheel:participant_joined received after user ${i + 1} joined`,
        ev.wheelId === wheelId && typeof ev.participantCount === 'number',
        `count=${ev.participantCount}`,
      );
    } catch (err) {
      fail(`wheel:participant_joined received after user ${i + 1} joined`, err.message);
    }
  }

  // ── wheel:started ─────────────────────────────────────────────────────────────
  section('wheel:started — emitted to room when admin starts wheel');

  const startedListeners = userSockets.map((s) => waitForEvent(s, 'wheel:started', 10000));

  // Also capture wheel:new_active on the admin (who is not in the room via userSockets)
  const newActivePromise = waitForEvent(adminSocket, 'wheel:new_active', 10000);

  // Admin starts wheel via HTTP
  {
    const { status } = await req('POST', `/api/wheels/${wheelId}/start`, { token: adminToken });
    check('Admin starts wheel via HTTP → 200', status === 200, `status=${status}`);
  }

  try {
    const results = await Promise.all(startedListeners);
    const allCorrect = results.every(
      (r) => r.wheelId === wheelId && typeof r.participantCount === 'number',
    );
    check(
      'All 3 user clients received wheel:started',
      allCorrect,
      `participantCount=${results[0]?.participantCount}`,
    );
  } catch (err) {
    fail('All 3 user clients received wheel:started', err.message);
  }

  try {
    const ev = await newActivePromise;
    check('wheel:new_active broadcast received by admin client', ev.wheelId === wheelId);
  } catch (err) {
    fail('wheel:new_active broadcast received by admin client', err.message);
  }

  // ── Elimination events ─────────────────────────────────────────────────────
  section('Elimination events — wheel:elimination + wheel:you_were_eliminated');

  const numParticipants  = userIds.length;          // 3
  const numEliminations  = numParticipants - 1;     // 2
  const elimWaitMs       = (numParticipants * ELIM_INTERVAL_SECS + 10) * 1000;

  console.log(
    `  ⏳  Waiting ${elimWaitMs / 1000}s for ` +
    `${numEliminations} eliminations + winner finalization...`,
  );

  // Room: collect all wheel:elimination events (expect numEliminations)
  const elimEventsPromise = waitForEvents(
    userSockets[0], 'wheel:elimination', numEliminations, elimWaitMs,
  );

  // Personal: each user listens for their own you_were_eliminated
  const youEliminatedPromises = userSockets.map((s) =>
    waitForEvents(s, 'wheel:you_were_eliminated', 1, elimWaitMs).catch(() => null),
  );

  // Room: wait for wheel:completed
  const completedPromise = waitForEvent(userSockets[0], 'wheel:completed', elimWaitMs);

  // Personal: each user listens for wheel:you_won
  const youWonPromises = userSockets.map((s) =>
    waitForEvents(s, 'wheel:you_won', 1, elimWaitMs).catch(() => null),
  );

  // ── Wait for eliminations ──
  let elimEvents = [];
  try {
    elimEvents = await elimEventsPromise;
    check(
      `wheel:elimination fired ${numEliminations} times`,
      elimEvents.length === numEliminations,
      `count=${elimEvents.length}`,
    );
  } catch (err) {
    fail(`wheel:elimination fired ${numEliminations} times`, err.message);
  }

  // ── Personal elimination notifications ──
  const youEliminatedResults = await Promise.all(youEliminatedPromises);
  const totalPersonalElims   = youEliminatedResults.filter((r) => r !== null && r.length > 0).length;
  check(
    `${numEliminations} users received wheel:you_were_eliminated personally`,
    totalPersonalElims === numEliminations,
    `received=${totalPersonalElims}`,
  );

  // ── wheel:completed ──
  let completedEvent = null;
  try {
    completedEvent = await completedPromise;
    check(
      'wheel:completed received by room clients',
      completedEvent.wheelId === wheelId && !!completedEvent.winnerUserId,
      `winner=${completedEvent.winnerUserId}`,
    );
  } catch (err) {
    fail('wheel:completed received by room clients', err.message);
  }

  // ── wheel:you_won ──
  const youWonResults = await Promise.all(youWonPromises);
  const totalYouWon   = youWonResults.filter((r) => r !== null && r.length > 0).length;
  check('Winner received wheel:you_won personally', totalYouWon === 1, `count=${totalYouWon}`);

  // ── Winner balance ──────────────────────────────────────────────────────────
  section('Winner balance — DB verification');

  if (completedEvent?.winnerUserId) {
    const winnerBalance = await getUserBalance(completedEvent.winnerUserId);
    // 100 (start) - ENTRY_FEE (join) + (3 × ENTRY_FEE × WINNER_PCT / 100) = prize pool
    const expectedBalance = 100 - ENTRY_FEE + (numParticipants * ENTRY_FEE * WINNER_PCT / 100);
    check(
      `Winner balance = ${expectedBalance.toFixed(2)}`,
      winnerBalance !== null && Math.abs(winnerBalance - expectedBalance) < 0.01,
      `actual=${winnerBalance}`,
    );
  } else {
    fail('Winner balance check', 'no winnerUserId from wheel:completed event');
  }

  // ── wheel:get_state ────────────────────────────────────────────────────────
  section('wheel:get_state — request current wheel state');

  try {
    const statePromise = waitForEvent(userSockets[0], 'wheel:state', 6000);
    userSockets[0].emit('wheel:get_state', { wheelId });
    const stateEvent = await statePromise;

    check(
      'wheel:state received with wheel object',
      stateEvent?.wheel != null && stateEvent.wheel.id === wheelId,
      `status=${stateEvent?.wheel?.status}`,
    );

    const hasParticipants = Array.isArray(stateEvent?.wheel?.participants);
    check('wheel:state includes participants array', hasParticipants, `isArray=${hasParticipants}`);
  } catch (err) {
    fail('wheel:get_state → wheel:state', err.message);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  section('Cleanup');

  // Disconnect all socket clients
  for (const socket of allSockets) {
    try { socket.disconnect(); } catch { /* ignore */ }
  }
  console.log(`  🔌  Disconnected ${allSockets.length} socket client(s).`);

  // Delete test data from DB
  try {
    if (allWheelIds.length > 0) {
      await pool.query(
        'DELETE FROM spin_wheel_participants WHERE spin_wheel_id = ANY($1::uuid[])',
        [allWheelIds],
      );
    }
    if (allUserIds.length > 0) {
      await pool.query(
        'DELETE FROM transactions WHERE user_id = ANY($1::uuid[])',
        [allUserIds],
      );
    }
    if (allWheelIds.length > 0) {
      await pool.query('DELETE FROM spin_wheels WHERE id = ANY($1::uuid[])', [allWheelIds]);
    }
    if (allUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [allUserIds]);
    }
    console.log(
      `  🧹  Cleaned up ${allUserIds.length} account(s) and ${allWheelIds.length} wheel(s).`,
    );
  } catch (err) {
    console.error(`  ⚠️  Cleanup error: ${err.message}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  console.log('\n━━━ Spin-Wheel Backend — Phase 6 Socket Integration Test ━━━');
  console.log(`    Target: ${BASE_URL}\n`);

  let adminSocket  = null;
  let userSockets  = [];

  try {
    await setup();

    if (!adminToken || userTokens.length < 3 || userIds.length < 3) {
      fail('Pre-flight', 'Setup incomplete — missing tokens/userIds. Aborting.');
    } else {
      const sockets = await testSocketConnections();
      adminSocket = sockets.adminSocket;
      userSockets = sockets.userSockets;

      await testGameFlow(adminSocket, userSockets);
    }
  } catch (err) {
    console.error('\n[Fatal] Unhandled error during test:', err);
    failed++;
  } finally {
    await cleanup();
    await pool.end();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Passed: ${passed}   Failed: ${failed}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (failed === 0) {
      console.log('🎉  All checks passed — Phase 6 verified!\n');
      process.exit(0);
    } else {
      console.error(`❌  ${failed} check(s) failed — review output above.\n`);
      process.exit(1);
    }
  }
})();
