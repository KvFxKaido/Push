# Push Runtime Schemas

These JSON Schema files describe the `push.runtime.v1` wire protocol documented in `docs/cli/design/Push Runtime Protocol.md`.

## Current Status

These schemas are **spec artifacts/documentation**, not runtime-loaded code.

- They are referenced by design docs and planning docs.
- They are **not** loaded directly by Push runtime code.
- Runtime strict-mode validation is implemented separately in `lib/protocol-schema.ts`, which hand-validates the active `push.runtime.v1` event envelope and selected run-event payloads.
- A future cleanup can either wire these JSON Schema files into tests/runtime validation or retire them in favor of the hand-rolled validator.

### Coverage scope (read before relying on these)

The `requestType` and `eventType` **enums** in `push-runtime-defs.schema.json` are kept current with the runtime: the request vocabulary mirrors the `HANDLERS` map in `cli/pushd.ts`, and the event vocabulary mirrors the wire events broadcast on `kind:'event'` envelopes (per-payload validators live in `lib/protocol-schema.ts`'s `PAYLOAD_VALIDATORS`). Use them as the authoritative list of *which verbs/events exist*.

The **per-type payload-shape branches** in the envelope schemas, by contrast, only cover the original MVP subset (session lifecycle, messaging, approvals, cancel). Verbs and events added later — the delegation suite, addressable-session verbs (`session_summarize`/`session_revert`/`session_unrevert`/`list_children`/`get_child_session`), sandbox ops, device/auth/relay management — validate their envelope and base fields but fall through to a generic `payload: object` with no per-field shape constraint. There is no drift-detector test pinning these files, so treat the runtime (`cli/pushd.ts`, its composed handler modules such as `cli/pushd/child-session-handlers.ts` and `cli/pushd/delegation-coordinator.ts`, and `lib/protocol-schema.ts`) as the source of truth for payload shapes, not these documents.

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
