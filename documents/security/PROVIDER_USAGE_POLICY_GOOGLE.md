# Provider Usage Policy — Google Gemini API

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

Related policies:
- Mistral: `documents/security/PROVIDER_USAGE_POLICY.md`
- OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- Z.AI: `documents/security/PROVIDER_USAGE_POLICY_ZAI.md`

## Scope

This policy covers Google Gemini API key usage and operational terms/data-boundary checks for Push web and Push CLI.

## Google Key Policy

- Supported key type for Push Google mode: Gemini API key for `generativelanguage.googleapis.com` (Push default uses the OpenAI-compatible endpoint at `/v1beta/openai/*`).
- Web usage:
  - Local dev: `VITE_GOOGLE_API_KEY`
  - Production worker: `GOOGLE_API_KEY` secret
- CLI usage:
  - Env: `PUSH_GOOGLE_API_KEY`
  - Config: `./push config set --provider google --api-key <key>`

### Unsupported key types for Push Google mode

- Non-Google provider keys for Google Gemini endpoints.
- Public/client-exposed Gemini keys in shipped frontend/mobile bundles.
- Defaulting to OAuth/service-account credentials as a drop-in replacement for Push's API-key flow without explicit adapter changes.

## Terms/Data Boundary (Operational)

- Gemini API usage is governed by Google Gemini API Additional Terms, Google API terms, and the Gemini API Prohibited Use Policy.
- Google usage policy states prompts/context/output can be retained for abuse monitoring (including human review in some cases) for up to 55 days.
- Google usage policy also states retained abuse-monitoring data is not used to train or fine-tune AI/ML models.
- API key guidance requires keeping keys secret and avoiding key exposure in source control or client bundles.
- This is an engineering operations policy, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear Google key in Settings.
  - Remove Worker secret `GOOGLE_API_KEY`.
- CLI:
  - Switch provider: `/provider openrouter` (or `mistral` / `ollama` / `zai`) in-session.
  - Remove `PUSH_GOOGLE_API_KEY` from environment or config.
- Keep at least one alternate provider configured before disabling Google Gemini.

## Review Procedure

At each quarterly review:

1. Re-check official docs/terms/policy links below.
2. Confirm key type, endpoint, and data-handling assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- Gemini OpenAI compatibility (endpoint + API key): https://ai.google.dev/gemini-api/docs/openai
- Gemini API key guidance (secure key handling): https://ai.google.dev/gemini-api/docs/api-key
- Gemini API Additional Terms (Google): https://ai.google.dev/gemini-api/terms
- Gemini API usage policies (abuse monitoring + retention): https://ai.google.dev/gemini-api/docs/usage-policies
- Gemini API Prohibited Use Policy: https://ai.google.dev/gemini-api/docs/prohibited-use-policy
