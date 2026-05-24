require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = require('./src/app');
const { initSocket } = require('./src/socket');

const PORT = process.env.PORT || 3000;

// Wrap Express in a raw HTTP server so Socket.io can share the same port
const server = http.createServer(app);

const { createAdapter } = require('@socket.io/redis-adapter');
const { redisClient, redisSubscriber } = require('./src/config/redis');

// Attach Socket.io with CORS restricted to the client origin
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
  },
  adapter: createAdapter(redisClient, redisSubscriber),
});

initSocket(io);

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT} — env: ${process.env.NODE_ENV || 'development'}`);
});
