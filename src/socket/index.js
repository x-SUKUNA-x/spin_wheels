'use strict';

/**
 * src/socket/index.js
 * -------------------
 * Wraps the Socket.io server instance so any service can emit events
 * without creating circular module dependencies.
 */

/** @type {import('socket.io').Server|null} */
let _io = null;

/**
 * Store the io instance and attach connection/disconnect logging.
 * Called once from server.js during startup.
 * @param {import('socket.io').Server} io
 */
const initSocket = (io) => {
  _io = io;

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected:    ${socket.id}`);

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} — reason: ${reason}`);
    });
  });
};

/**
 * Return the stored io instance.
 * Returns null (never throws) if called before initSocket — callers must
 * handle the null case gracefully.
 * @returns {import('socket.io').Server|null}
 */
const getIo = () => {
  if (!_io) {
    console.warn('[Socket] getIo() called before initSocket — no io instance available');
    return null;
  }
  return _io;
};

module.exports = { initSocket, getIo };
