'use strict';
/**
 * scripts/test_phase7.js
 * ----------------------
 * End-to-end integration test for Phase 7: Admin APIs and Transactions.
 *
 * Exits 0 if all pass, 1 if any fail.
 */

require('dotenv').config();

const { pool }         = require('../src/config/db');
const { creditCoins }  = require('../src/services/coin.service');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Game config — fetched from DB at runtime
let ENTRY_FEE, WINNER_PCT, ADMIN_PCT, ELIM_INTERVAL_SECS, MIN_PARTICIPANTS;

// ── Test accounts ─────────────────────────────────────────────────────────────

const ADMIN_CREDS = { username: 'p7_admin', email: 'p7_admin@test.com', password: 'Admin1234!', role: 'admin' };
const USER_CREDS  = [
  { username: 'p7_user1', email: 'p7_user1@test.com', password: 'User1234!', role: 'user' },
  { username: 'p7_user2', email: 'p7_user2@test.com', password: 'User1234!', role: 'user' },
  { username: 'p7_user3', email: 'p7_user3@test.com', password: 'User1234!', role: 'user' },
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  const configRes = await pool.query('SELECT * FROM spin_wheel_config LIMIT 1');
  if (configRes.rows.length === 0) throw new Error('spin_wheel_config table is empty');
  const config = configRes.rows[0];
  ENTRY_FEE          = parseFloat(config.entry_fee);
  WINNER_PCT         = parseFloat(config.winner_pool_percent);
  ADMIN_PCT          = parseFloat(config.admin_pool_percent);
  ELIM_INTERVAL_SECS = parseInt(config.elimination_interval_seconds, 10);
  MIN_PARTICIPANTS   = parseInt(config.min_participants, 10);

  section('Setup');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  section('Cleanup');

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
  console.log('\n━━━ Spin-Wheel Backend — Phase 7 Integration Test ━━━');
  console.log(`    Target: ${BASE_URL}\n`);

  try {
    await setup();

    // 1. Register 1 admin + 3 users → confirm 201 each, save tokens and userIds
    section('1. Register users');
    {
      const { status, data } = await req('POST', '/api/auth/register', { body: ADMIN_CREDS });
      check('Register admin', status === 201 && !!data?.data?.token, `status=${status}`);
      if (data?.data?.token) {
        adminToken  = data.data.token;
        adminUserId = data.data.user.id;
        allUserIds.push(adminUserId);
      }
    }
    for (let i = 0; i < USER_CREDS.length; i++) {
      const { status, data } = await req('POST', '/api/auth/register', { body: USER_CREDS[i] });
      check(`Register user${i + 1}`, status === 201 && !!data?.data?.token, `status=${status}`);
      if (data?.data?.token) {
        userTokens.push(data.data.token);
        userIds.push(data.data.user.id);
        allUserIds.push(data.data.user.id);
      }
    }

    // 2. Credit each of the 3 users with 100 coins via direct DB transaction
    section('2. Credit users via DB');
    for (let i = 0; i < userIds.length; i++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { newBalance } = await creditCoins(
          client, userIds[i], 100.00, null, 'admin_credit', 'Phase 7 test setup',
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

    // 3. GET /api/admin/config with admin token → confirm 200, response has entry_fee, winner_pool_percent, min_participants
    section('3-8. Admin Config endpoints');
    {
      const { status, data } = await req('GET', '/api/admin/config', { token: adminToken });
      const hasFields = data?.data?.config?.entry_fee && data?.data?.config?.winner_pool_percent && data?.data?.config?.min_participants;
      check('GET config with admin token', status === 200 && hasFields, `status=${status}`);
    }

    // 4. GET /api/admin/config with regular user token → confirm 403
    {
      const { status } = await req('GET', '/api/admin/config', { token: userTokens[0] });
      check('GET config with user token', status === 403, `status=${status}`);
    }

    // 5. PATCH /api/admin/config with { entry_fee: 15.00 } → confirm 200, entry_fee is now 15.00 in response
    {
      const { status, data } = await req('PATCH', '/api/admin/config', { token: adminToken, body: { entry_fee: 15.00 } });
      check('PATCH config (entry_fee: 15)', status === 200 && parseFloat(data?.data?.config?.entry_fee) === 15.00, `status=${status}`);
    }

    // 6. PATCH /api/admin/config with { winner_pool_percent: 80, admin_pool_percent: 80, app_pool_percent: 80 } → confirm 400
    {
      const body = { winner_pool_percent: 80, admin_pool_percent: 80, app_pool_percent: 80 };
      const { status } = await req('PATCH', '/api/admin/config', { token: adminToken, body });
      check('PATCH config invalid percents sum', status === 400, `status=${status}`);
    }

    // 7. PATCH /api/admin/config with { entry_fee: -5 } → confirm 400
    {
      const { status } = await req('PATCH', '/api/admin/config', { token: adminToken, body: { entry_fee: -5 } });
      check('PATCH config negative entry_fee', status === 400, `status=${status}`);
    }

    // 8. Restore config: PATCH /api/admin/config with { entry_fee: 10.00 } → confirm 200
    {
      // Using ENTRY_FEE read from DB initially
      const { status, data } = await req('PATCH', '/api/admin/config', { token: adminToken, body: { entry_fee: ENTRY_FEE } });
      check(`Restore config entry_fee to ${ENTRY_FEE}`, status === 200 && parseFloat(data?.data?.config?.entry_fee) === ENTRY_FEE, `status=${status}`);
    }

    // 9. Create a wheel, have all 3 users join, admin starts, wait for completion (read wait time from DB config)
    section('9. Game flow to completion');
    let wheelId;
    {
      const { status, data } = await req('POST', '/api/wheels', { token: adminToken });
      check('Create wheel', status === 201 && !!data?.data?.wheel?.id, `status=${status}`);
      wheelId = data?.data?.wheel?.id;
      if (wheelId) allWheelIds.push(wheelId);
    }

    if (wheelId) {
      for (let i = 0; i < userIds.length; i++) {
        const { status } = await req('POST', `/api/wheels/${wheelId}/join`, { token: userTokens[i] });
        check(`User${i + 1} joins`, status === 200, `status=${status}`);
      }

      const { status } = await req('POST', `/api/wheels/${wheelId}/start`, { token: adminToken });
      check('Admin starts wheel', status === 200, `status=${status}`);

      const numParticipants = userIds.length;
      const elimWaitMs = (numParticipants * ELIM_INTERVAL_SECS + 5) * 1000;
      console.log(`  ⏳  Waiting ${elimWaitMs / 1000}s for wheel completion...`);
      await sleep(elimWaitMs);
      pass('Wait completed');
    }

    // 10. GET /api/admin/wheels → confirm 200, total >= 1, wheels array present
    section('10-11. Admin Wheels endpoints');
    {
      const { status, data } = await req('GET', '/api/admin/wheels', { token: adminToken });
      check('GET /api/admin/wheels', status === 200 && data?.data?.total >= 1 && Array.isArray(data?.data?.wheels), `status=${status}`);
    }

    // 11. GET /api/admin/wheels/:wheelId → confirm 200, response has participantCount === 3 and transactions array with length > 0
    if (wheelId) {
      const { status, data } = await req('GET', `/api/admin/wheels/${wheelId}`, { token: adminToken });
      const ok = status === 200 && parseInt(data?.data?.wheel?.participantCount) === 3 && Array.isArray(data?.data?.wheel?.transactions) && data?.data?.wheel?.transactions.length > 0;
      check('GET /api/admin/wheels/:wheelId', ok, `status=${status}, participants=${data?.data?.wheel?.participantCount}, txs=${data?.data?.wheel?.transactions?.length}`);
    } else {
      fail('GET /api/admin/wheels/:wheelId', 'no wheelId');
    }

    // 12. GET /api/admin/users → confirm 200, total >= 4, users array present, no user has password_hash field
    section('12-14. Admin Users & Coin manipulation endpoints');
    {
      const { status, data } = await req('GET', '/api/admin/users', { token: adminToken });
      const users = data?.data?.users || [];
      const ok = status === 200 && data?.data?.total >= 4 && Array.isArray(users) && users.every(u => !u.hasOwnProperty('password_hash'));
      check('GET /api/admin/users', ok, `status=${status}, total=${data?.data?.total}`);
    }

    // 13. POST /api/admin/users/:userId/coins with { amount: 50, type: 'credit', description: 'Test bonus' } → confirm 200, newBalance increased by 50
    if (userIds[0]) {
      // get initial balance from DB
      const r = await pool.query('SELECT coin_balance FROM users WHERE id = $1', [userIds[0]]);
      const initialBalance = parseFloat(r.rows[0].coin_balance);

      const body = { amount: 50, type: 'credit', description: 'Test bonus' };
      const { status, data } = await req('POST', `/api/admin/users/${userIds[0]}/coins`, { token: adminToken, body });
      const newBalance = parseFloat(data?.data?.newBalance);
      check('POST credit 50 coins via admin', status === 200 && newBalance === initialBalance + 50, `status=${status}, newBalance=${newBalance}`);
    }

    // 14. POST /api/admin/users/:userId/coins with { amount: 99999, type: 'debit', description: 'Test overdraft' } → confirm 400
    if (userIds[0]) {
      const body = { amount: 99999, type: 'debit', description: 'Test overdraft' };
      const { status } = await req('POST', `/api/admin/users/${userIds[0]}/coins`, { token: adminToken, body });
      check('POST debit overdraft via admin', status === 400, `status=${status}`);
    }

    // 15. GET /api/transactions/me with user token → confirm 200, total >= 1, transactions array present
    section('15-17. Transactions endpoints');
    {
      const { status, data } = await req('GET', '/api/transactions/me', { token: userTokens[0] });
      check('GET /api/transactions/me', status === 200 && data?.data?.total >= 1 && Array.isArray(data?.data?.transactions), `status=${status}`);
    }

    // 16. GET /api/transactions/wheel/:wheelId → confirm 200, transactions array has entries
    if (wheelId) {
      const { status, data } = await req('GET', `/api/transactions/wheel/${wheelId}`, { token: userTokens[0] });
      check('GET /api/transactions/wheel/:wheelId', status === 200 && Array.isArray(data?.data?.transactions) && data?.data?.transactions.length > 0, `status=${status}`);
    }

    // 17. GET /api/transactions/wheel/invalid-uuid → confirm 400
    {
      const { status } = await req('GET', '/api/transactions/wheel/invalid-uuid', { token: userTokens[0] });
      check('GET /api/transactions/wheel/invalid-uuid', status === 400, `status=${status}`);
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
      console.log('🎉  All checks passed — Phase 7 verified!\n');
      process.exit(0);
    } else {
      console.error(`❌  ${failed} check(s) failed — review output above.\n`);
      process.exit(1);
    }
  }
})();
