require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

const MIGRATIONS_DIR = __dirname;

async function runMigrations() {
  // Collect all .sql files and sort by numeric prefix
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`[Migrate] Found ${files.length} migration file(s).\n`);

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`[Migrate] Running: ${file} ...`);

    await pool.query(sql);

    console.log(`[Migrate] Done:    ${file}`);
  }

  console.log('\n[Migrate] All migrations completed successfully.');
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[Migrate] Migration failed:', err.message);
    process.exit(1);
  });
