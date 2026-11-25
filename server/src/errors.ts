// Errors shared across modules.

/** The provider isn't set up yet (no key, no model chosen). The fix is in Settings, not a retry. */
export class NotConfiguredError extends Error {}
