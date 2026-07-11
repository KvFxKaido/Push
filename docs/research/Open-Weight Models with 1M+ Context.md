# Open-Weight Models with 1M+ Context

Model-native and deployment-native reference · Updated July 10, 2026

**Bottom line.** The credible open-weight 1M+ field now includes Llama 4, DeepSeek V4, GLM-5.2, LongCat 2.0, MiniMax M3, dedicated Qwen2.5-1M checkpoints, and several Qwen models that can be extended to 1M. For Push, two rankings matter: whether a model suits long-horizon coding, and whether weights plus a 1M-token KV cache fit on infrastructure that can realistically be rented.

## Model reference

| Model | Context | Support | What matters |
|---|---|---|---|
| [Llama 4 Scout](https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct) | 10M | Designed / trained | 109B total / 17B active; multimodal. Largest advertised window, though full-window retrieval quality should be validated per workload. |
| [Llama 4 Maverick](https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct) | 1M | Designed / trained | 400B total / 17B active; multimodal. Heavier weights than Scout despite the same active-parameter count. |
| [DeepSeek V4 Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) | 1M | Designed / trained | 1.6T total / 49B active. Native long-context architecture, but exceptionally large to host. |
| [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) | 1M | Designed / trained | 284B total / 13B active. A more practical hosted-inference candidate than V4 Pro. |
| [GLM-5.2](https://huggingface.co/zai-org/GLM-5.2) | 1M | Designed / trained | 744B total / 40B active. Explicitly positioned for stable long-horizon coding and agent work. |
| [LongCat 2.0](https://huggingface.co/meituan-longcat/LongCat-2.0) | 1M | Designed / trained | 1.6T total / ~48B active. Trained on hundreds of billions of tokens of 1M-context data. |
| [Qwen2.5 Instruct 1M](https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-1M) | 1M | Dedicated 1M checkpoint | Available in 7B and 14B variants. Older, but still the most manageable local option in this group. |
| [Qwen3 30B-A3B 2507](https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507) | 1M | Extended | Officially supported 1M configuration for Instruct and Thinking variants; approximately 240 GB GPU memory at full context per Qwen. |
| [Qwen3-Coder 30B-A3B](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) | 256K native / 1M | Extended with YaRN | Repository-oriented coding model. Treat performance in the outer portion of the extended window as something to test, not assume. |
| [MiniMax M3](https://huggingface.co/MiniMaxAI/MiniMax-M3) | 1M (512K guaranteed tier) | Designed / trained | ~428B-class MoE with MiniMax Sparse Attention; native multimodal, agentic-coding positioned. Already in Push's HF roster — budgeted at 512K because that is the *standard billing tier* (above 512K bills at 2×), not the model ceiling (`lib/context-budget.ts`). |

**Llama 4 and the deployment filter.** Scout (~109 GB FP8) fits a 4×A100 node more easily than anything else in this table, and Maverick fits the 8×H200 class — both pass the endpoint filter below. They are excluded from the Push shortlist on coding quality, not feasibility: Llama 4's coding reputation is the weakest of this field, and Push's workload is coding. Scout may still be worth a cheap sanity run precisely because it is the least expensive trained-at-1M+ endpoint available.

## How to interpret "1M context"

**Designed or trained around 1M.** The model architecture, training data, or dedicated checkpoint explicitly targets long-context operation. This is the strongest category, although retrieval and instruction retention still need workload-specific evaluation.

**Extended to 1M.** The released model normally uses a smaller native window and reaches 1M through scaling techniques such as YaRN. It may accept the tokens without using the entire window equally well.

**Hosted 1M versus open-weight 1M.** A provider may expose a hosted 1M version while the downloadable weights default to a smaller context. Those should not automatically be counted as equivalent open-weight 1M releases.

## Tool calling and API dialect

Context arithmetic is necessary but not sufficient for Push: a model that cannot do reliable native function calling at depth fails the eval regardless of window size.

- **DeepSeek V4** speaks both the OpenAI ChatCompletions and Anthropic dialects natively — it drops into Anthropic-shaped tooling without a proxy. (Note the DeepSeek Anthropic bridge validates `messages[]` more strictly than real Anthropic.)
- **GLM-5.2** and **LongCat 2.0** are agentic-coding positioned with native tool calling; both are OpenAI-dialect.
- **Qwen3 / Qwen3-Coder** have mature tool-calling support in vLLM (Hermes-style parser); Qwen2.5-1M predates the strongest of it — verify tool-call consistency at depth before trusting it in the eval.
- Tool-call *consistency as context grows* is a first-class eval axis (see Evaluation notes), not a checkbox.

## The dedicated-endpoint filter

Deployment-native means more than "the model has weights." Weights, runtime overhead, workspaces, and the KV cache must fit on one rentable node unless the serving platform supports a more complex multi-node deployment. The inference engine must also implement the model's attention architecture correctly.

| HF instance | GPU memory | Listed rate | Deployment implication |
|---|---|---|---|
| AWS 4×A100 | 320 GB | $10/hour | Potential Qwen3 30B-A3B learning endpoint if its reported ~240 GB full-context requirement holds. |
| AWS 8×A100 | 640 GB | $20/hour | Possible V4 Flash capacity class, subject to runtime overhead and architecture support. |
| AWS 8×H200 | 1,128 GB | $40/hour | Large single-node ceiling listed by HF; still insufficient for 1.6T FP8 weights plus runtime and KV cache. |
| GCP 8×H100 | 640 GB | $80/hour | Same aggregate GPU memory as 8×A100, but substantially higher listed endpoint cost. |

Prices are Hugging Face list rates as viewed July 10, 2026; billing is calculated by the minute. Availability and quota vary by account and region.

## Deployment-native shortlist for Push

| Candidate | Role | Likely path | Decision |
|---|---|---|---|
| Qwen3 30B-A3B-1M | Learning baseline | 4×A100/H100 class | **Start here.** Mature Qwen serving support makes it suitable for learning KV budgeting, YaRN or dual-chunk configuration, vLLM flags, and long-prefill behavior. |
| DeepSeek V4 Flash | Serious 1M evaluation | 8×80 GB class | **Headline endpoint candidate.** Its compressed attention makes 1M plausible, but verify vLLM, TGI, or SGLang support before treating this as deployable. |
| GLM-5.2 | Hosted control | Z.ai API | **Keep API-side.** Self-hosting a 744B-class model is marginal and expensive; compare it against dedicated endpoints throughout testing. |
| MiniMax M3 | Zero-setup hosted candidate | Already in the HF roster | **Test first, deploy never (for now).** Native 1M via sparse attention and reachable through Push's existing HF provider today; evaluate the 1M long-context tier via API (2× billing above 512K) before considering ~430GB-class self-hosting. |
| Qwen2.5-14B-1M | Cheaper baseline | Smaller multi-GPU node | Use for inexpensive configuration and workflow debugging before paying for larger endpoints. |
| V4 Pro / LongCat 2.0 | API only | External provider | At roughly 1.6T parameters, FP8 weights alone approach 1.6 TB. These exceed a listed 8×H200 node before runtime or KV allocation. |

## Recommended evaluation sequence

1. **Qwen3 30B-A3B at 1M.** Learn endpoint mechanics and measure real prefill latency, memory use, tool consistency, and instruction retention. Prefer the cheapest supported node with adequate headroom; the official HF list currently makes AWS A100 substantially cheaper than GCP H100.
2. **DeepSeek V4 Flash.** Move to an 8-GPU node only after confirming serving-engine support for its CSA/HCA attention and a viable 1M configuration. Treat nominal FP8 weight size as a floor, not the total residency requirement.
3. **GLM-5.2 via Z.ai.** Use the hosted model as the comparison point throughout. Dedicated deployment should earn its added operational cost through latency, privacy, control, or sustained utilization.

## Endpoint lifecycle in Push

A scale-to-zero endpoint behaves more like provisioned workspace infrastructure than an ordinary always-ready API. Push should expose its lifecycle explicitly:

- **Stopped** — no active compute; the model is unavailable.
- **Starting** — show provisioning progress or hold the request with an appropriate timeout.
- **Ready** — begin or resume the coding session.
- **Idle grace period** — keep the endpoint warm while the session remains active.
- **Checkpointed and stopped** — persist Push state before releasing the GPUs.

**Cold-start warning:** Hugging Face states that scale-up can take a few minutes and returns HTTP 503 while initializing unless a scale-up timeout is used. The cost saved by scale-to-zero is paid back in interactive latency — especially when hundreds of gigabytes of weights must load.

> This section is quietly a feature spec, not reference material: a model backend that takes minutes to become available is a new concept for Push's provider layer, which currently assumes every backend is always-ready. If the endpoint route is pursued, this graduates into a `docs/decisions/` draft and intersects the provider-registry work (#1202).

## Recommendation

For a Push-style coding workload: treat Qwen3 30B-A3B-1M as the deployment-learning baseline, DeepSeek V4 Flash as the serious dedicated-endpoint candidate, and GLM-5.2 through Z.ai as the hosted control. Keep Qwen2.5-14B-1M as the cheaper debugging path. LongCat 2.0 and DeepSeek V4 Pro remain model-native but not practical single-node endpoint candidates.

## Evaluation notes

- Test retrieval at several depths, not only a single needle placed near the end.
- Measure instruction retention, cross-file reasoning, and tool-call consistency as context grows.
- Track time-to-first-token, prefill cost, KV-cache memory, and repeated-turn cost — not just maximum input size.
- Separate "request accepted" from "information used correctly." A million-token HTTP 200 is not a cognition benchmark.
- Record endpoint cold-start time and distinguish it from model time-to-first-token.
- Verify serving-engine support for novel attention implementations before reserving expensive hardware.

## Deployment sources

- [Hugging Face Inference Endpoints pricing](https://huggingface.co/docs/inference-endpoints/pricing)
- [Hugging Face autoscaling and scale-to-zero](https://huggingface.co/docs/inference-endpoints/guides/autoscaling)
- [Hugging Face vLLM configuration and parallelism](https://huggingface.co/docs/inference-endpoints/engines/vllm)
