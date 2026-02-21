# Provider Usage Policy — Mistral

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

Related policies:
- OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- Z.AI: `documents/security/PROVIDER_USAGE_POLICY_ZAI.md`
- Google Gemini: `documents/security/PROVIDER_USAGE_POLICY_GOOGLE.md`
- OpenCode Zen: `documents/security/PROVIDER_USAGE_POLICY_ZEN.md`

## Scope

This policy covers provider API key usage and terms-boundary checks for Push web and Push CLI.

## Mistral Key Policy

- Supported key type for Push: standard workspace API key for `api.mistral.ai`.
- Web usage:
  - Local dev: `VITE_MISTRAL_API_KEY`
  - Production worker: `MISTRAL_API_KEY` secret
- CLI usage:
  - Env: `PUSH_MISTRAL_API_KEY`
  - Config: `./push config set --provider mistral --api-key <key>`

### Unsupported key types for Push

- Auto-generated **Mistral Code extension** keys.
- **Codestral-only** domain keys/endpoints in default Push configuration.

## Terms Boundary (Operational)

- Personal/internal usage: consumer terms path.
- Business usage or distribution to third-party end users: commercial terms path.
- This is an engineering policy for operations and documentation hygiene, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear Mistral key in Settings.
  - Remove Worker secret `MISTRAL_API_KEY`.
- CLI:
  - Switch provider: `/provider openrouter` (or `ollama`) in-session.
  - Remove `PUSH_MISTRAL_API_KEY` from environment or config file.
- Keep at least one alternate provider configured before disabling Mistral.

## Review Procedure

At each quarterly review:

1. Re-check official docs/help/terms links below.
2. Confirm supported key type and endpoint assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- Mistral Vibe configuration: https://docs.mistral.ai/mistral-vibe/introduction/configuration
- Codestral capability docs: https://docs.mistral.ai/capabilities/code_generation/
- Mistral Help (Mistral Code separate key): https://help.mistral.ai/en/articles/347592-do-i-need-a-separate-api-key-for-mistral-code
- Mistral Help (workspace API keys): https://help.mistral.ai/en/articles/347464-how-do-i-create-api-keys-within-a-workspace
- ROW consumer terms: https://legal.mistral.ai/terms/row-consumer-terms
- Commercial terms: https://legal.mistral.ai/terms/commercial-terms-of-service
