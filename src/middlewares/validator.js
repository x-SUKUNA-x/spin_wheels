const { validationResult, body } = require('express-validator');

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
}

const authValidators = {
  register: [
    body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Username must be alphanumeric and underscores only.'),
    body('email').trim().isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).matches(/[a-zA-Z]/).matches(/[0-9]/).withMessage('Password must contain letters and numbers.'),
    validateRequest
  ],
  login: [
    body('email').trim().isEmail().normalizeEmail(),
    body('password').notEmpty(),
    validateRequest
  ],
  refresh: [
    body('refreshToken').notEmpty(),
    validateRequest
  ]
};

module.exports = {
  validateRequest,
  authValidators
};
