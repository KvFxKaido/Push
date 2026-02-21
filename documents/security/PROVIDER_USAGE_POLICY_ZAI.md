# Provider Usage Policy — Z.AI

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

Related policies:
- Mistral: `documents/security/PROVIDER_USAGE_POLICY.md`
- OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- Google Gemini: `documents/security/PROVIDER_USAGE_POLICY_GOOGLE.md`

## Scope

This policy covers Z.AI API key usage and operational terms/data-boundary checks for Push web and Push CLI.

## Z.AI Key Policy

- Supported key type for Push Z.AI mode: Z.AI Open Platform API key for `https://api.z.ai/api/coding/paas/v4/*` (default Push endpoint for coding).
- Web usage:
  - Local dev: `VITE_ZAI_API_KEY`
  - Production worker: `ZAI_API_KEY` secret
- CLI usage:
  - Env: `PUSH_ZAI_API_KEY`
  - Config: `./push config set --provider zai --api-key <key>`

### Unsupported key types for Push Z.AI mode

- Non-Z.AI provider keys for Z.AI endpoints.
- Browser/session credentials copied from web app sessions instead of API keys.
- Public/client-exposed Z.AI keys in shipped frontend/mobile bundles.

## Terms/Data Boundary (Operational)

- API usage is governed by Z.AI Terms of Use plus Additional Terms for API Services.
- Additional Terms explicitly permit integration into downstream systems/apps for end users, with developer responsibility for end-user compliance and controls.
- Z.AI states API-service end-user content is not used to develop/improve services unless explicitly agreed.
- This is an engineering operations policy, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear Z.AI key in Settings.
  - Remove Worker secret `ZAI_API_KEY`.
- CLI:
  - Switch provider: `/provider openrouter` (or `mistral` / `ollama` / `google`) in-session.
  - Remove `PUSH_ZAI_API_KEY` from environment or config.
- Keep at least one alternate provider configured before disabling Z.AI.

## Review Procedure

At each quarterly review:

1. Re-check official docs/terms links below.
2. Confirm supported key type, endpoint, and data-handling assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- Z.AI API introduction + bearer authentication: https://docs.z.ai/api-reference/introduction
- Z.AI quickstart (key creation): https://docs.z.ai/guides
- Z.AI key management: https://docs.z.ai/guides/manage-apikey
- Z.AI Terms of Use (+ Additional Terms for API Services): https://docs.z.ai/legal-agreement/terms-of-use
- Z.AI Privacy Policy (+ API DPA reference): https://docs.z.ai/legal-agreement/privacy-policy
