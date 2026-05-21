'use strict';

/**
 * Socket.io event reference
 *
 * SERVER → CLIENT:
 *   wheel:created           — new wheel created, broadcast to all
 *   wheel:participant_joined — someone joined, broadcast to wheel room
 *   wheel:started           — wheel started spinning, broadcast to wheel room
 *   wheel:elimination       — a user eliminated, broadcast to wheel room
 *   wheel:completed         — game over, winner decided, broadcast to wheel room
 *   wheel:aborted           — wheel aborted, broadcast to wheel room
 *   wheel:you_were_eliminated — personal notification to eliminated user
 *   wheel:you_won           — personal notification to winner
 *   wheel:new_active        — a wheel became active, broadcast to all
 *   wheel:state             — response to wheel:get_state request
 *   wheel:room_joined       — confirmation of joining a wheel room
 *   wheel:error             — error response
 *
 * CLIENT → SERVER:
 *   wheel:join_room         — join a wheel's socket room
 *   wheel:leave_room        — leave a wheel's socket room
 *   wheel:get_state         — request current wheel state
 */

const jwt = require('jsonwebtoken');
const { getWheelWithParticipants } = require('../services/spinWheel.service');

/** @type {import('socket.io').Server|null} */
let _io = null;

/**
 * JWT authentication middleware for socket connections.
 * Reads token from socket.handshake.auth.token or Authorization header.
 */
const socketAuthMiddleware = (socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace('Bearer ', '').trim();

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = { id: decoded.id, role: decoded.role };
    return next();
  } catch (err) {
    return next(new Error('Invalid or expired token'));
  }
};

/**
 * Initialise Socket.io — store instance, apply auth middleware,
 * register connection and event handlers.
 * @param {import('socket.io').Server} io
 */
const initSocket = (io) => {
  _io = io;

  // Apply JWT auth to every incoming socket connection
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected:    ${socket.id} (user: ${socket.user.id})`);

    // Each user automatically joins their personal room for direct notifications
    socket.join(`user:${socket.user.id}`);

    // Join a wheel's broadcast room
    socket.on('wheel:join_room', ({ wheelId } = {}) => {
      if (!wheelId || typeof wheelId !== 'string') return;
      socket.join(`wheel:${wheelId}`);
      socket.emit('wheel:room_joined', { wheelId });
    });

    // Leave a wheel's broadcast room
    socket.on('wheel:leave_room', ({ wheelId } = {}) => {
      if (!wheelId || typeof wheelId !== 'string') return;
      socket.leave(`wheel:${wheelId}`);
    });

    // Request current wheel state
    socket.on('wheel:get_state', async ({ wheelId } = {}) => {
      if (!wheelId || typeof wheelId !== 'string') {
        socket.emit('wheel:error', { message: 'wheelId is required' });
        return;
      }
      try {
        const wheel = await getWheelWithParticipants(wheelId);
        socket.emit('wheel:state', { wheel });
      } catch (err) {
        console.error(`[Socket] wheel:get_state error for wheel ${wheelId}:`, err.message);
        socket.emit('wheel:error', { message: 'Failed to fetch wheel state' });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} — reason: ${reason}`);
    });
  });
};

/**
 * Returns the stored io instance.
 * Returns null (with a warning) if called before initSocket.
 * @returns {import('socket.io').Server|null}
 */
const getIo = () => {
  if (!_io) {
    console.warn('[Socket] getIo() called before initSocket — no io instance available');
    return null;
  }
  return _io;
};

/**
 * Emit an event to all sockets in a wheel room.
 * Fire-and-forget — never throws.
 * @param {string} wheelId
 * @param {string} event
 * @param {object} data
 */
const emitToWheel = (wheelId, event, data) => {
  try {
    const io = getIo();
    if (!io) return;
    io.to(`wheel:${wheelId}`).emit(event, data);
  } catch (err) {
    console.error(`[Socket] emitToWheel error — event: ${event}, wheel: ${wheelId}:`, err.message);
  }
};

/**
 * Emit an event to a specific user's personal room.
 * Fire-and-forget — never throws.
 * @param {string} userId
 * @param {string} event
 * @param {object} data
 */
const emitToUser = (userId, event, data) => {
  try {
    const io = getIo();
    if (!io) return;
    io.to(`user:${userId}`).emit(event, data);
  } catch (err) {
    console.error(`[Socket] emitToUser error — event: ${event}, user: ${userId}:`, err.message);
  }
};

/**
 * Broadcast an event to all connected sockets.
 * Fire-and-forget — never throws.
 * @param {string} event
 * @param {object} data
 */
const emitToAll = (event, data) => {
  try {
    const io = getIo();
    if (!io) return;
    io.emit(event, data);
  } catch (err) {
    console.error(`[Socket] emitToAll error — event: ${event}:`, err.message);
  }
};

module.exports = { initSocket, getIo, emitToWheel, emitToUser, emitToAll };
