/**
 * ResponseUtil — shared HTTP response helpers for IAM controllers/handlers.
 *
 * Collapses the repeated
 *   res.status(x).json({ response_status: { status_code: y, status: '...', message: z } })
 * blocks into two one-line calls: success() and fail().
 */

/**
 * @param {import('express').Response} res
 * @param {object} [data]        — extra top-level fields (e.g. { auth_account, token }).
 *                                  A `message` key is folded into response_status instead
 *                                  of being spread at the top level.
 * @param {number} [statusCode]  — business status_code, defaults to 2000.
 */
function success(res, data = {}, statusCode = 2000) {
    const { message, ...rest } = data;
    const response_status = { status_code: statusCode, status: 'success' };
    if (message) response_status.message = message;
    return res.status(200).json({ response_status, ...rest });
}

/**
 * @param {import('express').Response} res
 * @param {number} httpStatus  — HTTP status code (400, 401, 403, 404, 409, 500, ...)
 * @param {number} statusCode  — business status_code (4000, 4001, 5000, ...)
 * @param {string} message
 */
function fail(res, httpStatus, statusCode, message) {
    return res.status(httpStatus).json({
        response_status: { status_code: statusCode, status: 'failed', message }
    });
}

module.exports = { success, fail };
