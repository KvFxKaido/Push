# Push Runtime Schemas

These JSON Schema files define the MVP wire protocol documented in `documents/cli/design/Push Runtime Protocol.md`.

## Current Status

These schemas are currently **spec artifacts/documentation** for the proposed runtime protocol.

- They are referenced by design docs and planning docs.
- They are **not** currently loaded by Push runtime code or enforced in CLI/app tests.
- A future `pushd` implementation may add optional or required schema validation using these files.

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

- `documents/cli/schemas/push-runtime-envelope.schema.json`

When validating from code, ensure relative `$ref` resolution is enabled.
