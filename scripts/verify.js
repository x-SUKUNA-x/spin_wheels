'use strict';
/**
 * scripts/verify.js
 * -----------------
 * Environment & schema health-check.
 *
 * Usage:
 *   npm run verify
 *
 * Exits 0 if all checks pass, 1 if any fail.
 * Does NOT require the HTTP server to be running.
 */

require('dotenv').config();

const { pool } = require('../src/config/db');

// ── Helpers ────────────────────────────────────────────────────────────────

const PASS = '✅';
const FAIL = '❌';

let allPassed = true;

function pass(label, detail = '') {
  console.log(`${PASS}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail = '') {
  console.error(`${FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
  allPassed = false;
}

async function check(label, fn) {
  try {
    const detail = await fn();
    pass(label, detail);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── Checks ─────────────────────────────────────────────────────────────────

async function runChecks() {
  console.log('\n━━━ Spin-Wheel Backend — Environment Verification ━━━\n');

  // 1. Database connectivity
  await check('Database connection (SELECT NOW())', async () => {
    const { rows } = await pool.query('SELECT NOW() AS now');
    return `server time = ${rows[0].now.toISOString()}`;
  });

  // 2. users table
  await check('Table "users" exists', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    return `${rows[0].cnt} row(s)`;
  });

  // 3. transactions table
  await check('Table "transactions" exists', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM transactions');
    return `${rows[0].cnt} row(s)`;
  });

  // 4. spin_wheel_config table — must have exactly 1 row (singleton config)
  await check('Table "spin_wheel_config" exists and has 1 row', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM spin_wheel_config');
    const cnt = Number(rows[0].cnt);
    if (cnt !== 1) {
      throw new Error(`expected 1 row, got ${cnt}`);
    }
    return `${cnt} row (singleton config ✓)`;
  });

  // 5. spin_wheels table
  await check('Table "spin_wheels" exists', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM spin_wheels');
    return `${rows[0].cnt} row(s)`;
  });

  // 6. spin_wheel_participants table
  await check('Table "spin_wheel_participants" exists', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM spin_wheel_participants');
    return `${rows[0].cnt} row(s)`;
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  try {
    await runChecks();
  } catch (err) {
    // Unexpected failure outside individual checks
    console.error(`\n${FAIL}  Unexpected error:`, err.message);
    allPassed = false;
  } finally {
    await pool.end();
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    if (allPassed) {
      console.log('🎉  All checks passed — database is ready for Phase 4.\n');
      process.exit(0);
    } else {
      console.error('❌  One or more checks failed — fix the issues above before proceeding.\n');
      process.exit(1);
    }
  }
})();
