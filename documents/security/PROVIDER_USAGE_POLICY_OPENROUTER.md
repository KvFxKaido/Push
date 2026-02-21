# Provider Usage Policy — OpenRouter

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

Related policies:
- Mistral: `documents/security/PROVIDER_USAGE_POLICY.md`
- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- Z.AI: `documents/security/PROVIDER_USAGE_POLICY_ZAI.md`
- Google Gemini: `documents/security/PROVIDER_USAGE_POLICY_GOOGLE.md`
- OpenCode Zen: `documents/security/PROVIDER_USAGE_POLICY_ZEN.md`

## Scope

This policy covers OpenRouter API key usage and operational terms-boundary checks for Push web and Push CLI.

## OpenRouter Key Policy

- Supported key type for Push OpenRouter mode: OpenRouter API key for `https://openrouter.ai/api/v1/*`.
- Web usage:
  - Local dev: `VITE_OPENROUTER_API_KEY`
  - Production worker: `OPENROUTER_API_KEY` secret
- CLI usage:
  - Env: `PUSH_OPENROUTER_API_KEY`
  - Config: `./push config set --provider openrouter --api-key <key>`

### Unsupported key types for Push OpenRouter mode

- Provider-native keys (e.g. Anthropic/OpenAI direct keys) for OpenRouter endpoints.
- Public/client-exposed OpenRouter keys in shipped frontend/mobile bundles.

## Terms Boundary (Operational)

- If using on behalf of an organization, ensure account authority and organizational approval.
- OpenRouter terms require compliance with the selected upstream model/provider terms.
- This is an engineering operations policy, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear OpenRouter key in Settings.
  - Remove Worker secret `OPENROUTER_API_KEY`.
- CLI:
  - Switch provider: `/provider ollama` (or `mistral`) in-session.
  - Remove `PUSH_OPENROUTER_API_KEY` from environment or config.
- Keep at least one alternate provider configured before disabling OpenRouter.

## Review Procedure

At each quarterly review:

1. Re-check official docs/terms links below.
2. Confirm key type, endpoint, and terms assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- OpenRouter authentication + key guidance: https://openrouter.ai/docs/api-reference/authentication
- OpenRouter quickstart (Bearer key usage): https://openrouter.ai/docs/quickstart
- OpenRouter terms of service: https://openrouter.ai/terms
