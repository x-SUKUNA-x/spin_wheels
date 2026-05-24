const { registerUser, loginUser, generateAuthTokens, getUserById } = require('../services/auth.service');

async function register(req, res) {
  try {
    const { username, email, password, role } = req.body;
    const user = await registerUser({ username, email, password, role });
    const tokens = await generateAuthTokens(user);

    return res.status(201).json({ success: true, data: { user, token: tokens.accessToken } });
  } catch (err) {
    if (err.isOperational) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error('[AuthController] register error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    const user = await loginUser({ email, password });
    const tokens = await generateAuthTokens(user);

    return res.status(200).json({ success: true, data: { user, token: tokens.accessToken } });
  } catch (err) {
    if (err.isOperational) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error('[AuthController] login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function getMe(req, res) {
  try {
    const user = await getUserById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.status(200).json({ success: true, data: { user } });
  } catch (err) {
    console.error('[AuthController] getMe error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { register, login, getMe };
