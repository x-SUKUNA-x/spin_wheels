const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const SALT_ROUNDS = 12;

// ── Validators ───────────────────────────────────────────────────────

function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new AppError('Username is required.', 400, 'VALIDATION_ERROR');
  }
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 50) {
    throw new AppError('Username must be between 3 and 50 characters.', 400, 'VALIDATION_ERROR');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new AppError('Username may only contain letters, numbers, and underscores.', 400, 'VALIDATION_ERROR');
  }
  return trimmed;
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new AppError('Email is required.', 400, 'VALIDATION_ERROR');
  }
  const trimmed = email.trim().toLowerCase();
  // RFC-5322 simplified check — good enough for application-level validation
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(trimmed)) {
    throw new AppError('Invalid email format.', 400, 'VALIDATION_ERROR');
  }
  return trimmed;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    throw new AppError('Password is required.', 400, 'VALIDATION_ERROR');
  }
  if (password.length < 8) {
    throw new AppError('Password must be at least 8 characters.', 400, 'VALIDATION_ERROR');
  }
  if (!/[a-zA-Z]/.test(password)) {
    throw new AppError('Password must contain at least one letter.', 400, 'VALIDATION_ERROR');
  }
  if (!/[0-9]/.test(password)) {
    throw new AppError('Password must contain at least one number.', 400, 'VALIDATION_ERROR');
  }
}

function validateRole(role) {
  const allowed = ['user', 'admin'];
  if (role && !allowed.includes(role)) {
    throw new AppError(`Role must be one of: ${allowed.join(', ')}`, 400, 'VALIDATION_ERROR');
  }
  return role || 'user';
}

// ── Service Functions ────────────────────────────────────────────────

/**
 * Register a new user.
 * @returns {{ id, username, email, role, coin_balance, created_at }}
 */
async function registerUser({ username, email, password, role }) {
  const cleanUsername = validateUsername(username);
  const cleanEmail = validateEmail(email);
  validatePassword(password);
  const cleanRole = validateRole(role);

  // Check email uniqueness
  const emailCheck = await query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
  if (emailCheck.rows.length > 0) {
    throw new AppError('Email already registered.', 409, 'DUPLICATE_EMAIL');
  }

  // Check username uniqueness
  const usernameCheck = await query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
  if (usernameCheck.rows.length > 0) {
    throw new AppError('Username already taken.', 409, 'DUPLICATE_USERNAME');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, role, coin_balance, created_at`,
    [cleanUsername, cleanEmail, passwordHash, cleanRole],
  );

  return result.rows[0];
}

/**
 * Authenticate a user by email + password.
 * @returns {{ id, username, email, role, coin_balance }}
 */
async function loginUser({ email, password }) {
  if (!email || !password) {
    throw new AppError('Email and password are required.', 400, 'VALIDATION_ERROR');
  }

  const cleanEmail = email.trim().toLowerCase();

  const result = await query(
    'SELECT id, username, email, role, coin_balance, password_hash FROM users WHERE email = $1',
    [cleanEmail],
  );

  if (result.rows.length === 0) {
    throw new AppError('Invalid credentials.', 401, 'INVALID_CREDENTIALS');
  }

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password_hash);

  if (!match) {
    throw new AppError('Invalid credentials.', 401, 'INVALID_CREDENTIALS');
  }

  // Never return password_hash
  const { password_hash: _, ...safeUser } = user;
  return safeUser;
}

/**
 * Sign a JWT for the given user.
 * @returns {Promise<{ accessToken: string }>}
 */
async function generateAuthTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }, // Longer expiration since no refresh
  );

  return { accessToken };
}

/**
 * Fetch a user by id (safe fields only).
 * @returns {object|null}
 */
async function getUserById(id) {
  const result = await query(
    'SELECT id, username, email, role, coin_balance, created_at, updated_at FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] || null;
}

module.exports = { registerUser, loginUser, generateAuthTokens, getUserById };
