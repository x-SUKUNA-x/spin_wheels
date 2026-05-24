require('dotenv').config();
const { pool } = require('../src/config/db');

async function clean() {
  try {
    await pool.query('TRUNCATE TABLE users CASCADE;');
    await pool.query('TRUNCATE TABLE spin_wheels CASCADE;');
    await pool.query('TRUNCATE TABLE transactions CASCADE;');
    await pool.query('TRUNCATE TABLE spin_wheel_participants CASCADE;');
    console.log('Database cleaned');
  } catch (err) {
    console.error('Error cleaning database:', err);
  } finally {
    pool.end();
  }
}
clean();
