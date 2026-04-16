# Control Config Polymorphism — Decision Record

**Date:** 2026-04-04
**Status:** Implemented

## Context

`ControlPayload.config` was a single flat `Record<string, unknown>` with `control_type: 'connector_config'`. It was ambiguous: unclear whether the config update targeted the source or destination. The orchestrator hardcoded merging into `source`.

## Decision

Apply Stripe's standard `{type, [type]: payload}` polymorphism pattern to `ControlPayload`:

```typescript
ControlPayload = {
  control_type: 'source_config' | 'destination_config',
  source_config?: Record<string, unknown>,
  destination_config?: Record<string, unknown>,
}
```

The `control_type` discriminator names the sub-hash key (per Stripe API design: Trailhead `api-design/polymorphism-in-the-stripe-api`).

## Related changes

- **StateMessage → SourceStateMessage**: Renamed to clarify that state is always the source's cursor position, even when the destination echoes it back.
- **ConnectorSpecification**: Renamed `stream_state` → `source_state_stream`, added `source_state_global`, renamed `input` → `source_input`.
- **SourceInputMessage**: New protocol-level message type for source input data.
- **Principle 10**: Added "Stripe polymorphism pattern" to `docs/architecture/principles.md`.

## Alternatives considered

1. **Flat config + `_emitted_by` routing**: Keep config flat, orchestrator parses `_emitted_by: 'source/stripe'` to determine role. Simpler protocol but not self-describing.
2. **Engine wraps config in `{type, [type]: payload}` envelope**: Connector emits flat, engine transforms. Rejected because engine should be a transparent pipe — adding metadata (tags) is fine, but structural transformation is not.
3. **Connector self-identifies via `spec.name`**: Each connector declares its type name and wraps control configs itself. Too many abstraction layers for an internal service.
4. **Full Stripe `{type, [type]: payload}` on config field**: The nested envelope inside `config` created 4 levels of nesting. The `control_type`-as-discriminator approach is flatter.

## Future considerations

- Connector `spec.name` for richer self-description
- SourceInput may simplify from discriminated union to plain union
- Consider whether SourceInputMessage should be used in the `Source.read()` interface
