---
"@voltagent/core": patch
---

fix(core): remove vulnerable `undici@5.29.0` and `@fastify/busboy@2.1.1` from the dependency tree

`@ai-sdk/amazon-bedrock` and `@ai-sdk/google-vertex` move from `3.x` to `^4.0.0`, and `ollama-ai-provider-v2` moves from `1.x` to `^3.0.1`. The old releases depend on `@ai-sdk/provider-utils@3`, which pulls in `undici@5.29.0` and `@fastify/busboy@2.1.1` (CVE-2026-12151, CVE-2026-1526, CVE-2026-2229, CVE-2026-19481).

Downstream impact, only for `amazon-bedrock/*`, `google-vertex/*`, `google-vertex-anthropic/*` and `ollama/*` models:

- If `GOOGLE_VERTEX_API_KEY` is set, Vertex now uses express mode and ignores `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` and `GOOGLE_APPLICATION_CREDENTIALS`. Unset it if you rely on project credentials.
- Ollama reports `finishReason: "tool-calls"` instead of `"stop"` when the model returns tool calls.
- Ollama mid-stream errors still surface as an error part, now with `onError` and `finishReason: "error"`. Core's Ollama adapter detects them because `ollama-ai-provider-v2@3` drops them.
- Bedrock clamps a `temperature` above `1` to `1` and returns a warning.
