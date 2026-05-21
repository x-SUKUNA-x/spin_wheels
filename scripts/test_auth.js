'use strict';
/**
 * scripts/test_auth.js
 * ---------------------
 * End-to-end auth flow + coin service integration test.
 *
 * Prerequisites:
 *   Run the dev server in a separate terminal first:
 *     npm run dev
 *   Then in another terminal:
 *     npm run test:auth
 *
 * The script cleans up all test data it creates (users + their transactions)
 * before it exits, regardless of pass/fail.
 */

require('dotenv').config();

const { pool } = require('../src/config/db');
const { creditCoins, debitCoins } = require('../src/services/coin.service');

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ADMIN_CREDS = {
  username: 'admin_test',
  email: 'admin@test.com',
  password: 'Admin1234',
  role: 'admin',
};

const USER_CREDS = {
  username: 'user_test',
  email: 'user@test.com',
  password: 'User1234',
  role: 'user',
};

// ── Bookkeeping ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let adminToken = null;
let userToken = null;
const createdUserIds = []; // for cleanup

// ── Logging ─────────────────────────────────────────────────────────────────

function log(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✅  ${name}${detail ? ` — ${detail}` : ''}`);
    passed++;
  } else {
    console.error(`  ❌  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────────`);
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

async function request(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Response has no JSON body (e.g. 204)
  }

  return { status: res.status, data };
}

// ── Individual test cases ───────────────────────────────────────────────────

async function testRegisterAdmin() {
  const name = 'POST /api/auth/register — admin user';
  const { status, data } = await request('POST', '/api/auth/register', { body: ADMIN_CREDS });

  if (status === 201 && data?.data?.token) {
    adminToken = data.data.token;
    if (data.data.user?.id) createdUserIds.push(data.data.user.id);
    log(name, true, `status=${status}`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testRegisterUser() {
  const name = 'POST /api/auth/register — regular user';
  const { status, data } = await request('POST', '/api/auth/register', { body: USER_CREDS });

  if (status === 201 && data?.data?.token) {
    userToken = data.data.token;
    if (data.data.user?.id) createdUserIds.push(data.data.user.id);
    log(name, true, `status=${status}`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testLoginAdmin() {
  const name = 'POST /api/auth/login — valid admin credentials';
  const { status, data } = await request('POST', '/api/auth/login', {
    body: { email: ADMIN_CREDS.email, password: ADMIN_CREDS.password },
  });

  if (status === 200 && data?.data?.token) {
    log(name, true, `status=${status}`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testGetMe() {
  const name = 'GET /api/auth/me — authenticated';
  if (!adminToken) {
    log(name, false, 'skipped — no adminToken available');
    return;
  }

  const { status, data } = await request('GET', '/api/auth/me', { token: adminToken });

  if (status === 200 && data?.data?.user) {
    log(name, true, `user=${data.data.user.email}`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testDuplicateRegistration() {
  const name = 'POST /api/auth/register — duplicate email → 409';
  const { status, data } = await request('POST', '/api/auth/register', { body: ADMIN_CREDS });

  if (status === 409) {
    log(name, true, `status=${status} (expected)`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testInvalidLogin() {
  const name = 'POST /api/auth/login — wrong password → 401';
  const { status, data } = await request('POST', '/api/auth/login', {
    body: { email: ADMIN_CREDS.email, password: 'WrongPassword999' },
  });

  if (status === 401) {
    log(name, true, `status=${status} (expected)`);
  } else {
    log(name, false, `status=${status}, body=${JSON.stringify(data)}`);
  }
}

async function testUnauthenticatedAccess() {
  const name = 'GET /api/auth/me — no token → 401';
  const { status } = await request('GET', '/api/auth/me');

  if (status === 401) {
    log(name, true, `status=${status} (expected)`);
  } else {
    log(name, false, `status=${status}`);
  }
}

// ── Coin service direct tests ───────────────────────────────────────────────

async function testCoinService() {
  section('Coin Service (direct DB)');

  // Resolve admin user id from DB (avoids relying on token decode)
  const { rows } = await pool.query(
    'SELECT id, coin_balance FROM users WHERE email = $1',
    [ADMIN_CREDS.email],
  );

  if (rows.length === 0) {
    log('Coin service — locate admin user', false, 'user not found in DB; skipping coin tests');
    return;
  }

  const adminUserId = rows[0].id;

  // Read starting balance so tests are idempotent across re-runs
  const startingBalance = parseFloat(rows[0].coin_balance);

  // ── Credit 100.00 ────────────────────────────────────────────────────────
  {
    const name = 'creditCoins — credit 100.00 to admin';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { newBalance } = await creditCoins(client, adminUserId, 100.00, null, 'winner_credit', 'Test credit');
      await client.query('COMMIT');

      // Verify via fresh read — expect exactly +100 from where we started
      const { rows: check } = await pool.query('SELECT coin_balance FROM users WHERE id = $1', [adminUserId]);
      const actual = parseFloat(check[0].coin_balance);
      const expected = startingBalance + 100.00;
      if (Math.abs(actual - expected) < 0.001 && Math.abs(newBalance - expected) < 0.001) {
        log(name, true, `balance=${actual} (+100 from ${startingBalance})`);
      } else {
        log(name, false, `expected ${expected}, got balance=${actual}, returned=${newBalance}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      log(name, false, err.message);
    } finally {
      client.release();
    }
  }

  // ── Debit 50.00 ──────────────────────────────────────────────────────────
  {
    const name = 'debitCoins — debit 50.00 from admin';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { newBalance } = await debitCoins(client, adminUserId, 50.00, null, 'entry_fee_debit', 'Test debit');
      await client.query('COMMIT');

      const { rows: check } = await pool.query('SELECT coin_balance FROM users WHERE id = $1', [adminUserId]);
      const actual = parseFloat(check[0].coin_balance);
      const expected = startingBalance + 100.00 - 50.00;
      if (Math.abs(actual - expected) < 0.001 && Math.abs(newBalance - expected) < 0.001) {
        log(name, true, `balance=${actual} (-50 from ${startingBalance + 100})`);
      } else {
        log(name, false, `expected ${expected}, got balance=${actual}, returned=${newBalance}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      log(name, false, err.message);
    } finally {
      client.release();
    }
  }

  // ── Overdraft guard ──────────────────────────────────────────────────────
  // Current balance is startingBalance+50; try to debit far more than that
  {
    const overdraftAmount = startingBalance + 50.00 + 200.00; // guaranteed > balance
    const name = `debitCoins — overdraft (${overdraftAmount} > balance) → INSUFFICIENT_BALANCE`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await debitCoins(client, adminUserId, overdraftAmount, null, 'entry_fee_debit', 'Overdraft test');
      await client.query('COMMIT');
      // If we reach here the guard did NOT fire — that is a failure
      log(name, false, 'expected INSUFFICIENT_BALANCE error but none was thrown');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === 'INSUFFICIENT_BALANCE') {
        log(name, true, `threw INSUFFICIENT_BALANCE as expected`);
      } else {
        log(name, false, `wrong error: ${err.message} (code=${err.code})`);
      }
    } finally {
      client.release();
    }
  }

  // ── Reset balance back to starting value ─────────────────────────────────
  {
    const name = 'Coin cleanup — reset admin balance to original value';
    try {
      await pool.query('UPDATE users SET coin_balance = $1 WHERE id = $2', [startingBalance, adminUserId]);
      await pool.query(
        "DELETE FROM transactions WHERE user_id = $1 AND description LIKE 'Test %' OR description = 'Overdraft test'",
        [adminUserId],
      );
      log(name, true, `reset to ${startingBalance}`);
    } catch (err) {
      log(name, false, err.message);
    }
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  section('Cleanup');

  if (createdUserIds.length === 0) {
    console.log('  ℹ️  No test users were created — nothing to clean up.');
    return;
  }

  try {
    // Delete transactions first (FK constraint) then users
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::uuid[])', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    console.log(`  🧹  Cleaned up ${createdUserIds.length} test user(s) and their transactions.`);
  } catch (err) {
    console.error(`  ⚠️  Cleanup failed: ${err.message}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  console.log('\n━━━ Spin-Wheel Backend — Auth & Coin Service Test ━━━');
  console.log(`    Target: ${BASE_URL}\n`);

  try {
    section('Auth API');

    await testRegisterAdmin();
    await testRegisterUser();
    await testLoginAdmin();
    await testGetMe();
    await testDuplicateRegistration();
    await testInvalidLogin();
    await testUnauthenticatedAccess();

    await testCoinService();
  } finally {
    await cleanup();
    await pool.end();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Passed: ${passed}   Failed: ${failed}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (failed === 0) {
      console.log('🎉  All checks passed — ready for Phase 4!\n');
      process.exit(0);
    } else {
      console.error(`❌  ${failed} check(s) failed — fix before proceeding.\n`);
      process.exit(1);
    }
  }
})();
