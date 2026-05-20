/**
 * Initializes all Socket.io event listeners.
 * @param {import('socket.io').Server} io
 */
const initSocket = (io) => {
  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected:    ${socket.id}`);

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} — reason: ${reason}`);
    });
  });
};

module.exports = { initSocket };
