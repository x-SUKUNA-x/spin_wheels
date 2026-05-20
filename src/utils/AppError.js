/**
 * Custom error class that carries an HTTP status code and error code
 * so controllers can map business logic errors to the correct response.
 */
class AppError extends Error {
  /**
   * @param {string} message  - Human-readable error message
   * @param {number} statusCode - HTTP status code (400, 401, 409, etc.)
   * @param {string} [code]   - Machine-readable error code (e.g. 'VALIDATION_ERROR')
   */
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'APP_ERROR';
    this.isOperational = true; // distinguishes from unexpected crashes

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
