# Provider Usage Policy — OpenCode Zen

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

Related policies:
- Mistral: `documents/security/PROVIDER_USAGE_POLICY.md`
- OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- Z.AI: `documents/security/PROVIDER_USAGE_POLICY_ZAI.md`
- Google Gemini: `documents/security/PROVIDER_USAGE_POLICY_GOOGLE.md`

## Scope

This policy covers OpenCode Zen API key usage and operational terms/data-boundary checks for Push web and Push CLI.

## OpenCode Zen Key Policy

- Supported key type for Push Zen mode: OpenCode Zen API key for `https://opencode.ai/zen/v1/*`.
- Push endpoint usage:
  - Chat: `POST /zen/v1/chat/completions` (OpenAI-compatible path)
  - Models: `GET /zen/v1/models`
- Web usage:
  - Local dev: `VITE_ZEN_API_KEY`
  - Production worker: `ZEN_API_KEY` secret
- CLI usage:
  - Env: `PUSH_ZEN_API_KEY`
  - Config: `./push config set --provider zen --api-key <key>`

### Unsupported key types for Push Zen mode

- Non-OpenCode provider keys for Zen endpoints.
- Public/client-exposed Zen keys in shipped frontend/mobile bundles.
- Assuming the same payload format for `/responses` or `/messages` endpoints without adapter changes (Push currently targets chat-completions format).

## Terms/Data Boundary (Operational)

- Zen usage in Push should follow OpenCode Terms of Service and OpenCode docs.
- Current terms include language that the service is for your own internal use and not for the benefit of third parties.
- Treat this provider as personal/internal by default unless terms are updated or explicit written permission is obtained.
- This is an engineering operations policy, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear Zen key in Settings.
  - Remove Worker secret `ZEN_API_KEY`.
- CLI:
  - Switch provider: `/provider openrouter` (or `mistral` / `ollama` / `zai` / `google`) in-session.
  - Remove `PUSH_ZEN_API_KEY` from environment or config.
- Keep at least one alternate provider configured before disabling Zen.

## Review Procedure

At each quarterly review:

1. Re-check official docs/terms links below.
2. Confirm endpoint, key type, and terms assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- OpenCode Zen docs: https://opencode.ai/docs/zen
- OpenCode providers docs (Zen endpoint): https://opencode.ai/docs/providers
- OpenCode Zen dashboard: https://opencode.ai/zen
- OpenCode terms of service: https://opencode.ai/legal/terms-of-service
