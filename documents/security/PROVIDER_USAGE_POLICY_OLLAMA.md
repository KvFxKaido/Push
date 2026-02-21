# Provider Usage Policy — Ollama

Last reviewed: 2026-02-21  
Review cadence: Quarterly (next target: 2026-05-21)

## Scope

This policy covers Ollama API key usage and operational terms/data-boundary checks for Push web and Push CLI.

## Ollama Key Policy

- Local Ollama usage (`localhost`) does not require an API key.
- Ollama Cloud usage requires an API key via `Authorization: Bearer <key>`.
- Key source: `https://ollama.com/settings/keys`.
- Web usage:
  - Local dev: `VITE_OLLAMA_API_KEY` (for cloud-backed calls)
  - Production worker: `OLLAMA_API_KEY` secret
- CLI usage:
  - Env: `PUSH_OLLAMA_API_KEY`
  - Config: `./push config set --provider ollama --api-key <key>`

### Unsupported key types for Push Ollama mode

- Non-Ollama provider keys for Ollama endpoints.
- Public/client-exposed Ollama keys in shipped frontend/mobile bundles.

## Terms/Data Boundary (Operational)

- Treat Ollama Cloud usage as a hosted API service with provider terms and pricing.
- Current Ollama FAQ states cloud API data is not used for model training and endpoint request/response data is not logged.
- This is an engineering operations policy, not legal advice.

## Fast Off-Switch

- Web:
  - Remove/clear Ollama key in Settings.
  - Remove Worker secret `OLLAMA_API_KEY`.
- CLI:
  - Switch provider: `/provider openrouter` (or `mistral`) in-session.
  - Remove `PUSH_OLLAMA_API_KEY` from environment or config.
- Keep at least one alternate provider configured before disabling Ollama Cloud.

## Review Procedure

At each quarterly review:

1. Re-check official docs/terms/pricing links below.
2. Confirm key type, endpoint, and data-handling assumptions still hold.
3. Update "Last reviewed" date and next target date.
4. If terms changed materially, document required product/config changes in `documents/plans/`.

## References

- Ollama API reference (key optional local, required for cloud): https://docs.ollama.com/api
- Ollama API introduction: https://docs.ollama.com/api/introduction
- Ollama key management: https://ollama.com/settings/keys
- Ollama pricing (cloud plans): https://ollama.com/pricing
- Ollama FAQ (cloud data policy): https://ollama.com/faq
