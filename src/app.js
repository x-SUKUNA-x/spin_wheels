const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const expressWinston = require('express-winston');
const logger = require('./config/logger');

// Security headers
app.use(helmet());

// CORS — only allow the configured client origin
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Body parsing
app.use(express.json());

// Request Tracing Logger
app.use(expressWinston.logger({
  winstonInstance: logger,
  meta: true, // Log metadata (method, url, status)
  msg: 'HTTP {{req.method}} {{req.url}}',
  expressFormat: true,
  colorize: false,
  ignoreRoute: function (req, res) { return req.url.startsWith('/health') || req.url.startsWith('/metrics'); }
}));

const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('./config/redis');

// Global rate limiter: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,  // Return rate-limit info in RateLimit-* headers
  legacyHeaders: false,
  message: { message: 'Too many requests from this IP. Please try again after 15 minutes.' },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  }),
});
app.use(limiter);

const healthRouter = require('./routes/health.routes');
app.use('/', healthRouter);

// Routes
const authRouter = require('./routes/auth.routes');
app.use('/api/auth', authRouter);

const spinWheelRouter = require('./routes/spinWheel.routes');
app.use('/api/wheels', spinWheelRouter);

const adminRouter = require('./routes/admin.routes');
app.use('/api/admin', adminRouter);

const transactionRouter = require('./routes/transaction.routes');
app.use('/api/transactions', transactionRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

// Global error handler — catches anything that slips past controllers
app.use(expressWinston.errorLogger({
  winstonInstance: logger,
}));

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  if (!err.isOperational) {
    logger.error('[App] Unhandled error:', err);
  }
  res.status(statusCode).json({
    success: false,
    message: err.isOperational ? err.message : 'Internal server error',
  });
});

module.exports = app;
