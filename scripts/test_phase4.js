'use strict';
/**
 * scripts/test_phase4.js
 * ----------------------
 * End-to-end integration test for the Spin Wheel API (Phase 4).
 *
 * // Run: npm run dev in one terminal, then: npm run test:phase4 in another
 *
 * Covers:
 *  - Admin creates wheel (201)
 *  - Admin duplicate-creates wheel (409)
 *  - Users join wheel (200) with pool accumulator validation in DB
 *  - Duplicate join guard (409)
 *  - GET /api/wheels/active with participant count
 *  - GET /api/wheels/:wheelId with participants array
 *  - Non-admin create wheel (403)
 *  - Invalid UUID join attempt (400)
 *
 * Cleans up all test data on exit (even on failure).
 * Exits 0 if all pass, 1 if any fail.
 */

require('dotenv').config();

const { pool } = require('../src/config/db');
const { creditCoins } = require('../src/services/coin.service');

// ── Config ──────────────────────────────────────────────────────────────────

const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ADMIN = {
  username: 'p4_admin',
  email:    'p4_admin@test.com',
  password: 'Admin1234',
  role:     'admin',
};

const USERS = [
  { username: 'p4_user1', email: 'p4_user1@test.com', password: 'User1234', role: 'user' },
  { username: 'p4_user2', email: 'p4_user2@test.com', password: 'User1234', role: 'user' },
  { username: 'p4_user3', email: 'p4_user3@test.com', password: 'User1234', role: 'user' },
];

// ── State ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

let adminToken   = null;
let adminUserId  = null;
const userTokens = [];   // [token, token, token]
const userIds    = [];   // [id, id, id]

let createdWheelId  = null;
const allUserIds    = []; // admin + users — for cleanup

// ── Logging ──────────────────────────────────────────────────────────────────

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
  if (ok) pass(name, detail);
  else     fail(name, detail);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* no body */ }

  return { status: res.status, data };
}

// ── Setup: register accounts & credit coins ──────────────────────────────────

async function setup() {
  section('Setup — register accounts');

  // Register admin
  {
    const { status, data } = await req('POST', '/api/auth/register', { body: ADMIN });
    check('Register admin', status === 201 && data?.data?.token, `status=${status}`);
    if (data?.data?.token) {
      adminToken  = data.data.token;
      adminUserId = data.data.user.id;
      allUserIds.push(adminUserId);
    }
  }

  // Register regular users
  for (let i = 0; i < USERS.length; i++) {
    const { status, data } = await req('POST', '/api/auth/register', { body: USERS[i] });
    check(`Register user${i + 1}`, status === 201 && data?.data?.token, `status=${status}`);
    if (data?.data?.token) {
      userTokens.push(data.data.token);
      userIds.push(data.data.user.id);
      allUserIds.push(data.data.user.id);
    }
  }

  // Credit each regular user with 100 coins so they can pay the entry fee
  section('Setup — credit 100 coins to each user');
  for (let i = 0; i < userIds.length; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { newBalance } = await creditCoins(
        client,
        userIds[i],
        100.00,
        null,
        'admin_credit',
        'Phase 4 test setup credit',
      );
      await client.query('COMMIT');
      check(`Credit 100 coins → user${i + 1}`, newBalance === 100, `balance=${newBalance}`);
    } catch (err) {
      await client.query('ROLLBACK');
      fail(`Credit 100 coins → user${i + 1}`, err.message);
    } finally {
      client.release();
    }
  }
}

// ── Test cases ───────────────────────────────────────────────────────────────

async function testCreateWheel() {
  section('Create Wheel');

  // 1. Admin creates wheel → 201
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    const ok = status === 201 && data?.data?.wheel?.id;
    check('Admin creates wheel → 201', ok, `status=${status}`);
    if (ok) createdWheelId = data.data.wheel.id;
  }

  // 2. Admin tries to create a second wheel while one is active → 409
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    check(
      'Admin creates duplicate wheel → 409',
      status === 409 && data?.code === 'WHEEL_ALREADY_ACTIVE',
      `status=${status}, code=${data?.code}`,
    );
  }
}

async function testNonAdminCreateWheel() {
  section('Authorization Guard');

  // Non-admin tries to create a wheel → 403
  const token = userTokens[0];
  if (!token) { fail('Non-admin create wheel → 403', 'no user token available'); return; }

  const { status } = await req('POST', '/api/wheels', { token });
  check('Non-admin create wheel → 403', status === 403, `status=${status}`);
}

async function testInvalidUUID() {
  section('Input Validation');

  // Invalid UUID join → 400
  const { status } = await req('POST', '/api/wheels/not-a-uuid/join', { token: userTokens[0] });
  check('Join with invalid UUID → 400', status === 400, `status=${status}`);
}

async function testJoinWheel() {
  section('Join Wheel');

  if (!createdWheelId) {
    fail('Join wheel tests', 'skipped — no wheel was created');
    return;
  }

  // Fetch config to know expected pool percentages
  const configRes = await pool.query('SELECT * FROM spin_wheel_config LIMIT 1');
  const config = configRes.rows[0];
  const entryFee         = parseFloat(config.entry_fee);
  const winnerPct        = parseFloat(config.winner_pool_percent);
  const adminPct         = parseFloat(config.admin_pool_percent);
  const appPct           = parseFloat(config.app_pool_percent);

  // Helper: fetch wheel pools from DB
  async function getWheelPools() {
    const r = await pool.query(
      'SELECT winner_pool_accumulated, admin_pool_accumulated, app_pool_accumulated FROM spin_wheels WHERE id = $1',
      [createdWheelId],
    );
    return r.rows[0];
  }

  // User 1 joins → 200
  {
    const { status, data } = await req('POST', `/api/wheels/${createdWheelId}/join`, { token: userTokens[0] });
    const ok = status === 200 && data?.data?.participant && data?.data?.wheel;
    check('User 1 joins wheel → 200', ok, `status=${status}`);

    if (ok) {
      // Verify pool accumulators after 1 join (all math done in PG)
      const pools = await getWheelPools();
      const expectedWinner = (entryFee * winnerPct / 100);
      const expectedAdmin  = (entryFee * adminPct  / 100);
      const expectedApp    = (entryFee * appPct    / 100);

      check(
        'Pool accumulators correct after user 1 join',
        Math.abs(parseFloat(pools.winner_pool_accumulated) - expectedWinner) < 0.001 &&
        Math.abs(parseFloat(pools.admin_pool_accumulated)  - expectedAdmin)  < 0.001 &&
        Math.abs(parseFloat(pools.app_pool_accumulated)    - expectedApp)    < 0.001,
        `winner=${pools.winner_pool_accumulated}, admin=${pools.admin_pool_accumulated}, app=${pools.app_pool_accumulated}`,
      );
    }
  }

  // User 1 tries to join again → 409
  {
    const { status, data } = await req('POST', `/api/wheels/${createdWheelId}/join`, { token: userTokens[0] });
    check(
      'User 1 joins again → 409',
      status === 409 && data?.code === 'ALREADY_JOINED',
      `status=${status}, code=${data?.code}`,
    );
  }

  // User 2 joins → 200
  {
    const { status, data } = await req('POST', `/api/wheels/${createdWheelId}/join`, { token: userTokens[1] });
    check('User 2 joins wheel → 200', status === 200 && data?.data?.participant, `status=${status}`);
  }

  // User 3 joins → 200
  {
    const { status, data } = await req('POST', `/api/wheels/${createdWheelId}/join`, { token: userTokens[2] });
    check('User 3 joins wheel → 200', status === 200 && data?.data?.participant, `status=${status}`);

    if (status === 200 && data?.data?.wheel) {
      // Verify pool accumulators after all 3 joins
      const pools = await getWheelPools();
      const n = 3;
      const expectedWinner = (entryFee * n * winnerPct / 100);
      const expectedAdmin  = (entryFee * n * adminPct  / 100);
      const expectedApp    = (entryFee * n * appPct    / 100);

      check(
        'Pool accumulators correct after all 3 joins',
        Math.abs(parseFloat(pools.winner_pool_accumulated) - expectedWinner) < 0.001 &&
        Math.abs(parseFloat(pools.admin_pool_accumulated)  - expectedAdmin)  < 0.001 &&
        Math.abs(parseFloat(pools.app_pool_accumulated)    - expectedApp)    < 0.001,
        `winner=${pools.winner_pool_accumulated}, admin=${pools.admin_pool_accumulated}, app=${pools.app_pool_accumulated}`,
      );
    }
  }
}

async function testGetActiveWheel() {
  section('GET /api/wheels/active');

  const { status, data } = await req('GET', '/api/wheels/active', { token: adminToken });
  const wheel = data?.data?.wheel;
  const ok = status === 200 && wheel !== undefined;
  check('GET /api/wheels/active → 200', ok, `status=${status}`);

  if (ok && wheel) {
    check(
      'Active wheel matches created wheel',
      wheel.id === createdWheelId,
      `id=${wheel.id}`,
    );
  } else if (ok && wheel === null) {
    fail('Active wheel returned null', 'expected an active wheel to be present');
  }
}

async function testGetWheelById() {
  section('GET /api/wheels/:wheelId');

  if (!createdWheelId) {
    fail('GET /api/wheels/:wheelId', 'skipped — no wheel ID available');
    return;
  }

  const { status, data } = await req('GET', `/api/wheels/${createdWheelId}`, { token: adminToken });
  const wheel = data?.data?.wheel;
  const ok = status === 200 && wheel && Array.isArray(wheel.participants);
  check('GET /api/wheels/:wheelId → 200 with participants array', ok, `status=${status}`);

  if (ok) {
    check(
      'Participants array has 3 entries',
      wheel.participants.length === 3,
      `count=${wheel.participants.length}`,
    );

    // Confirm participant fields are present
    const firstP = wheel.participants[0];
    check(
      'Participant object has expected fields',
      firstP &&
        typeof firstP.participantId === 'string' &&
        typeof firstP.userId       === 'string' &&
        typeof firstP.username     === 'string' &&
        firstP.joinedAt !== undefined,
      `fields=${Object.keys(firstP || {}).join(', ')}`,
    );
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  section('Cleanup');

  if (allUserIds.length === 0) {
    console.log('  ℹ️  No test accounts created — nothing to clean up.');
    return;
  }

  try {
    // 1. Remove participant rows
    if (createdWheelId) {
      await pool.query('DELETE FROM spin_wheel_participants WHERE spin_wheel_id = $1', [createdWheelId]);
    }

    // 2. Remove transactions for all test users
    await pool.query(
      'DELETE FROM transactions WHERE user_id = ANY($1::uuid[])',
      [allUserIds],
    );

    // 3. Remove the wheel itself
    if (createdWheelId) {
      await pool.query('DELETE FROM spin_wheels WHERE id = $1', [createdWheelId]);
    }

    // 4. Remove test users
    await pool.query(
      'DELETE FROM users WHERE id = ANY($1::uuid[])',
      [allUserIds],
    );

    console.log(`  🧹  Cleaned up ${allUserIds.length} test account(s) and their associated data.`);
  } catch (err) {
    console.error(`  ⚠️  Cleanup failed: ${err.message}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  console.log('\n━━━ Spin-Wheel Backend — Phase 4 Integration Test ━━━');
  console.log(`    Target: ${BASE_URL}\n`);

  try {
    await setup();
    await testCreateWheel();
    await testNonAdminCreateWheel();
    await testInvalidUUID();
    await testJoinWheel();
    await testGetActiveWheel();
    await testGetWheelById();
  } finally {
    await cleanup();
    await pool.end();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Passed: ${passed}   Failed: ${failed}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (failed === 0) {
      console.log('🎉  All checks passed — Phase 4 verified!\n');
      process.exit(0);
    } else {
      console.error(`❌  ${failed} check(s) failed — review output above.\n`);
      process.exit(1);
    }
  }
})();
