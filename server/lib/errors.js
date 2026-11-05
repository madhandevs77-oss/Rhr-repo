export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}
export const badRequest = (msg, details, code = 'VALIDATION') => new AppError(400, code, msg, details)
export const unauthorized = (msg = 'Please sign in') => new AppError(401, 'UNAUTHENTICATED', msg)
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', msg)
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`)
export const conflict = (msg, code = 'CONFLICT', details) => new AppError(409, code, msg, details)
