# Push Runtime Schemas

These JSON Schema files define the MVP wire protocol documented in `docs/cli/design/Push Runtime Protocol.md`.

## Current Status

These schemas are currently **spec artifacts/documentation** for the runtime protocol.

- They are referenced by design docs and planning docs.
- They are **not** loaded directly by Push runtime code.
- Runtime strict-mode validation is implemented separately in `lib/protocol-schema.ts`, which hand-validates the active `push.runtime.v1` event envelope and selected run-event payloads.
- A future cleanup can either wire these JSON Schema files into tests/runtime validation or retire them in favor of the hand-rolled validator.

## Files

- `push-runtime-defs.schema.json`
  - Shared enums, IDs, and payload shape definitions.
- `push-runtime-request-envelope.schema.json`
  - Request envelope + type-specific payload validation.
- `push-runtime-response-envelope.schema.json`
  - Response envelope + success/failure shape rules.
- `push-runtime-event-envelope.schema.json`
  - Event envelope + event-type payload validation.
- `push-runtime-envelope.schema.json`
  - Aggregate entrypoint (`request | response | event`).

## Validation

Use any JSON Schema 2020-12 compatible validator and point it at:

- `docs/cli/schemas/push-runtime-envelope.schema.json`

When validating from code, ensure relative `$ref` resolution is enabled.
