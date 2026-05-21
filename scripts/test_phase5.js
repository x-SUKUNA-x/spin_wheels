'use strict';
/**
 * scripts/test_phase5.js
 * ----------------------
 * End-to-end integration test for Phase 5: elimination engine & game loop.
 *
 * // Run: npm run dev in one terminal, then: npm run test:phase5 in another
 *
 * Scenario A — Full game (manual start):
 *   Register 1 admin + 3 users, credit 100 each
 *   Admin creates wheel (auto-start timer fires, but admin starts manually first)
 *   3 users join
 *   Admin manually starts → confirm 200, wheel status = 'spinning'
 *   Wait for all eliminations + finalization
 *   Confirm winner balance, admin balance, transaction records
 *
 * Scenario B — Manual abort:
 *   2 users join a new wheel (below min), admin aborts
 *   Confirm refunds and status = 'aborted'
 *
 * Scenario C — Auto-abort (below min participants):
 *   Temporarily set auto_start_seconds = 5 in DB
 *   2 users join, wait 8 s, confirm auto-abort + refunds
 *   Restore config
 *
 * Exits 0 if all pass, 1 if any fail.
 */

require('dotenv').config();

const { pool } = require('../src/config/db');
const { creditCoins } = require('../src/services/coin.service');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Default config values from migration 003
const ENTRY_FEE          = 10.00;
const WINNER_PCT         = 70;   // 70%  → 7.00 per participant
const ADMIN_PCT          = 20;   // 20%  → 2.00 per participant
const ELIM_INTERVAL_SECS = 7;    // 7s per elimination step
const MIN_PARTICIPANTS   = 3;

// ── Test accounts ─────────────────────────────────────────────────────────────

const ADMIN = { username: 'p5_admin', email: 'p5_admin@test.com', password: 'Admin1234', role: 'admin' };
const USERS = [
  { username: 'p5_user1', email: 'p5_user1@test.com', password: 'User1234', role: 'user' },
  { username: 'p5_user2', email: 'p5_user2@test.com', password: 'User1234', role: 'user' },
  { username: 'p5_user3', email: 'p5_user3@test.com', password: 'User1234', role: 'user' },
];

// ── State ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

let adminToken  = null;
let adminUserId = null;
const userTokens = [];
const userIds    = [];
const allUserIds = [];       // admin + all users, for cleanup
const allWheelIds = [];      // every wheel created, for cleanup

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

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWheelFromDb(wheelId) {
  const r = await pool.query('SELECT * FROM spin_wheels WHERE id = $1', [wheelId]);
  return r.rows[0] || null;
}

async function getUserBalance(userId) {
  const r = await pool.query('SELECT coin_balance FROM users WHERE id = $1', [userId]);
  return r.rows.length ? parseFloat(r.rows[0].coin_balance) : null;
}

async function getTransactions(userId, type) {
  const r = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 AND type = $2',
    [userId, type],
  );
  return r.rows;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  section('Setup — register accounts');

  // Register admin
  {
    const { status, data } = await req('POST', '/api/auth/register', { body: ADMIN });
    check('Register admin', status === 201 && !!data?.data?.token, `status=${status}`);
    if (data?.data?.token) {
      adminToken  = data.data.token;
      adminUserId = data.data.user.id;
      allUserIds.push(adminUserId);
    }
  }

  // Register users
  for (let i = 0; i < USERS.length; i++) {
    const { status, data } = await req('POST', '/api/auth/register', { body: USERS[i] });
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
      const { newBalance } = await creditCoins(client, userIds[i], 100.00, null, 'admin_credit', 'Phase 5 test setup');
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

// ── Scenario A: Full game ─────────────────────────────────────────────────────

async function scenarioA() {
  section('Scenario A — Full game (manual start, 3 participants)');

  if (!adminToken || userIds.length < 3) {
    fail('Scenario A', 'skipped — missing tokens/users');
    return;
  }

  // Create wheel
  let wheelId = null;
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    check('Admin creates wheel → 201', status === 201 && !!data?.data?.wheel?.id, `status=${status}`);
    if (data?.data?.wheel?.id) {
      wheelId = data.data.wheel.id;
      allWheelIds.push(wheelId);
    } else return;
  }

  // Confirm status = 'waiting'
  {
    const wheel = await getWheelFromDb(wheelId);
    check('Wheel status = "waiting" after creation', wheel?.status === 'waiting', `status=${wheel?.status}`);
  }

  // All 3 users join
  for (let i = 0; i < 3; i++) {
    const { status } = await req('POST', `/api/wheels/${wheelId}/join`, { token: userTokens[i] });
    check(`User ${i + 1} joins → 200`, status === 200, `status=${status}`);
  }

  // Admin manually starts
  {
    const { status, data } = await req('POST', `/api/wheels/${wheelId}/start`, { token: adminToken });
    check('Admin manually starts wheel → 200', status === 200, `status=${status}`);

    // Confirm spinning status quickly (startWheel updates DB before returning)
    const wheel = await getWheelFromDb(wheelId);
    check('Wheel status = "spinning" after start', wheel?.status === 'spinning', `status=${wheel?.status}`);
  }

  // Wait for 3 participants: 2 eliminations + finalization
  // 2 eliminations × 7s + 5s buffer = 19s
  const waitMs = (2 * ELIM_INTERVAL_SECS + 5) * 1000;
  console.log(`\n  ⏳  Waiting ${waitMs / 1000}s for all eliminations to complete...`);
  await sleep(waitMs);

  // Verify DB final state
  {
    const wheel = await getWheelFromDb(wheelId);
    check('Wheel status = "completed"', wheel?.status === 'completed', `status=${wheel?.status}`);
    check('winner_user_id is set', !!wheel?.winner_user_id, `winner=${wheel?.winner_user_id}`);

    const winnerUserId = wheel?.winner_user_id;

    // Winner balance: started 100, paid 10 entry, received winner pool (3 × 10 × 70% = 21)
    const winnerBalance = await getUserBalance(winnerUserId);
    const expectedWinnerBalance = 100 - ENTRY_FEE + (3 * ENTRY_FEE * WINNER_PCT / 100);
    check(
      `Winner balance = ${expectedWinnerBalance}`,
      Math.abs(winnerBalance - expectedWinnerBalance) < 0.01,
      `actual=${winnerBalance}`,
    );

    // Admin balance: started 0 (admin didn't join), received admin pool (3 × 10 × 20% = 6)
    const adminBalance = await getUserBalance(adminUserId);
    const expectedAdminPool = 3 * ENTRY_FEE * ADMIN_PCT / 100;
    check(
      `Admin balance = ${expectedAdminPool} (admin pool only)`,
      Math.abs(adminBalance - expectedAdminPool) < 0.01,
      `actual=${adminBalance}`,
    );

    // All 3 users have entry_fee_debit transactions for this wheel
    for (let i = 0; i < 3; i++) {
      const txns = await getTransactions(userIds[i], 'entry_fee_debit');
      const wheelTxns = txns.filter((t) => t.spin_wheel_id === wheelId);
      check(`User ${i + 1} has entry_fee_debit transaction`, wheelTxns.length === 1, `count=${wheelTxns.length}`);
    }

    // Winner has winner_credit transaction
    if (winnerUserId) {
      const winnerTxns = await getTransactions(winnerUserId, 'winner_credit');
      const wheelTxns = winnerTxns.filter((t) => t.spin_wheel_id === wheelId);
      check('Winner has winner_credit transaction', wheelTxns.length === 1, `count=${wheelTxns.length}`);
    }

    // Admin has admin_credit transaction
    {
      const adminTxns = await getTransactions(adminUserId, 'admin_credit');
      const wheelTxns = adminTxns.filter((t) => t.spin_wheel_id === wheelId);
      check('Admin has admin_credit transaction', wheelTxns.length === 1, `count=${wheelTxns.length}`);
    }
  }
}

// ── Scenario B: Manual abort ──────────────────────────────────────────────────

async function scenarioB() {
  section('Scenario B — Manual abort (2 participants, admin aborts)');

  if (!adminToken || userIds.length < 2) {
    fail('Scenario B', 'skipped — missing tokens/users');
    return;
  }

  // Re-credit users (they spent 10 in scenario A if they were a loser)
  for (let i = 0; i < 2; i++) {
    const currentBalance = await getUserBalance(userIds[i]);
    if (currentBalance < ENTRY_FEE) {
      const topUp = ENTRY_FEE - currentBalance + 10;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await creditCoins(client, userIds[i], topUp, null, 'admin_credit', 'Scenario B top-up');
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }

  // Record balances before joining
  const balanceBefore = [
    await getUserBalance(userIds[0]),
    await getUserBalance(userIds[1]),
  ];

  // Create wheel
  let wheelId = null;
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    check('Create wheel for abort test → 201', status === 201, `status=${status}`);
    if (data?.data?.wheel?.id) {
      wheelId = data.data.wheel.id;
      allWheelIds.push(wheelId);
    } else return;
  }

  // 2 users join (below minimum)
  for (let i = 0; i < 2; i++) {
    const { status } = await req('POST', `/api/wheels/${wheelId}/join`, { token: userTokens[i] });
    check(`User ${i + 1} joins → 200`, status === 200, `status=${status}`);
  }

  // Admin aborts
  {
    const { status, data } = await req('POST', `/api/wheels/${wheelId}/abort`, { token: adminToken });
    check('Admin aborts wheel → 200', status === 200, `status=${status}`);
  }

  // Small delay for async abort to complete
  await sleep(1500);

  // Confirm status = 'aborted'
  {
    const wheel = await getWheelFromDb(wheelId);
    check('Wheel status = "aborted"', wheel?.status === 'aborted', `status=${wheel?.status}`);
  }

  // Confirm refunds — balances should be back to what they were before joining
  for (let i = 0; i < 2; i++) {
    const balanceAfter = await getUserBalance(userIds[i]);
    check(
      `User ${i + 1} refunded (balance restored)`,
      Math.abs(balanceAfter - balanceBefore[i]) < 0.01,
      `before=${balanceBefore[i]}, after=${balanceAfter}`,
    );
  }
}

// ── Scenario C: Auto-abort ────────────────────────────────────────────────────

async function scenarioC() {
  section('Scenario C — Auto-abort (2 participants, auto_start_seconds = 5)');

  if (!adminToken || userIds.length < 2) {
    fail('Scenario C', 'skipped — missing tokens/users');
    return;
  }

  // Override auto_start_seconds to 5 in DB
  await pool.query('UPDATE spin_wheel_config SET auto_start_seconds = 5 WHERE id = 1');
  console.log('  ℹ️  Temporarily set auto_start_seconds = 5');

  // Ensure users have enough balance
  for (let i = 0; i < 2; i++) {
    const currentBalance = await getUserBalance(userIds[i]);
    if (currentBalance < ENTRY_FEE) {
      const topUp = ENTRY_FEE + 5;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await creditCoins(client, userIds[i], topUp, null, 'admin_credit', 'Scenario C top-up');
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }

  const balanceBefore = [
    await getUserBalance(userIds[0]),
    await getUserBalance(userIds[1]),
  ];

  let wheelId = null;
  {
    const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
    check('Create wheel for auto-abort test → 201', status === 201, `status=${status}`);
    if (data?.data?.wheel?.id) {
      wheelId = data.data.wheel.id;
      allWheelIds.push(wheelId);
    } else {
      await pool.query('UPDATE spin_wheel_config SET auto_start_seconds = 180 WHERE id = 1');
      return;
    }
  }

  // 2 users join (below minimum)
  for (let i = 0; i < 2; i++) {
    const { status } = await req('POST', `/api/wheels/${wheelId}/join`, { token: userTokens[i] });
    check(`User ${i + 1} joins → 200`, status === 200, `status=${status}`);
  }

  // Wait for auto-start to fire (5s) + abort processing (3s buffer) = 8s
  console.log('  ⏳  Waiting 8s for auto-abort to fire...');
  await sleep(8000);

  // Confirm status = 'aborted'
  {
    const wheel = await getWheelFromDb(wheelId);
    check('Wheel status = "aborted" after auto-abort', wheel?.status === 'aborted', `status=${wheel?.status}`);
  }

  // Confirm refunds
  for (let i = 0; i < 2; i++) {
    const balanceAfter = await getUserBalance(userIds[i]);
    check(
      `User ${i + 1} refunded after auto-abort`,
      Math.abs(balanceAfter - balanceBefore[i]) < 0.01,
      `before=${balanceBefore[i]}, after=${balanceAfter}`,
    );
  }

  // Restore config
  await pool.query('UPDATE spin_wheel_config SET auto_start_seconds = 180 WHERE id = 1');
  console.log('  ✅  Restored auto_start_seconds = 180');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  section('Cleanup');

  try {
    if (allWheelIds.length > 0) {
      await pool.query('DELETE FROM spin_wheel_participants WHERE spin_wheel_id = ANY($1::uuid[])', [allWheelIds]);
    }
    if (allUserIds.length > 0) {
      await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::uuid[])', [allUserIds]);
    }
    if (allWheelIds.length > 0) {
      await pool.query('DELETE FROM spin_wheels WHERE id = ANY($1::uuid[])', [allWheelIds]);
    }
    if (allUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [allUserIds]);
    }
    console.log(`  🧹  Cleaned up ${allUserIds.length} account(s) and ${allWheelIds.length} wheel(s).`);
  } catch (err) {
    console.error(`  ⚠️  Cleanup error: ${err.message}`);
  }

  // Safety: restore config in case scenario C didn't finish
  try {
    await pool.query('UPDATE spin_wheel_config SET auto_start_seconds = 180 WHERE id = 1');
  } catch { /* ignore */ }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  console.log('\n━━━ Spin-Wheel Backend — Phase 5 Integration Test ━━━');
  console.log(`    Target: ${BASE_URL}\n`);

  try {
    await setup();
    await scenarioA();
    await scenarioB();
    await scenarioC();
  } finally {
    await cleanup();
    await pool.end();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Passed: ${passed}   Failed: ${failed}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (failed === 0) {
      console.log('🎉  All checks passed — Phase 5 verified!\n');
      process.exit(0);
    } else {
      console.error(`❌  ${failed} check(s) failed — review output above.\n`);
      process.exit(1);
    }
  }
})();
