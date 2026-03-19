/**
 * Re-export router functions and types from @stripe/sync-protocol.
 * These are pure message filters that belong in the protocol layer.
 *
 * The Postgres-specific collect() overload that accepted a PostgresStateManager
 * has been replaced with the protocol's version (which accepts only callbacks).
 * The _stateManager parameter was unused anyway.
 */
export { forward, collect, type RouterCallbacks } from '@stripe/sync-protocol'
