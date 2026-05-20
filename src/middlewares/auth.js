const jwt = require('jsonwebtoken');

/**
 * Express middleware that validates a Bearer JWT from the Authorization header.
 * On success, attaches `req.user = { id, role }` and calls next().
 * On failure, responds with 401.
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header missing or malformed. Expected: Bearer <token>' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Only expose the fields controllers actually need
    req.user = {
      id: decoded.id,
      role: decoded.role,
    };

    next();
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Token has expired. Please log in again.'
        : 'Invalid token. Authentication failed.';

    return res.status(401).json({ message });
  }
};

module.exports = { authenticate };
