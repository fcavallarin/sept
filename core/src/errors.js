/**
 * Thrown by system-event handlers when an event is rejected as invalid
 * (malformed payload, wrong network, conflicting keys, ...). Deterministic:
 * retrying the same event cannot succeed. The client halts on it.
 *
 * Any other error raised while applying a system event is treated as
 * transient (e.g. database busy) and retried.
 */
export class SeptProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = "SeptProtocolError"
    this.code = "SEPT_PROTOCOL_ERROR"
  }
}

// Not instanceof-based: works across duplicated package instances.
export function isSeptProtocolError(error) {
  return error?.code === "SEPT_PROTOCOL_ERROR"
}
