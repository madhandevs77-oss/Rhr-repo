// Registry that lets the payment layer work on either document type (hall booking / catering order)
// without importing them (avoids circular imports). bookings.js and catering.js register themselves.
const handlers = {}
export const registerDoc = (kind, h) => { handlers[kind] = h }
export const docHandler = (kind) => {
  if (!handlers[kind]) throw new Error(`No handler registered for ${kind}`)
  return handlers[kind]
}
