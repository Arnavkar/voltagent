---
"@voltagent/core": patch
---

fix(core): upgrade the Amazon Bedrock and Google Vertex providers to their AI SDK v6 releases

`@ai-sdk/amazon-bedrock` and `@ai-sdk/google-vertex` move from `3.x` to `^4.0.0`. The `3.x` releases depend on `@ai-sdk/provider-utils@3`, which pulls in `undici@5.29.0` and `@fastify/busboy@2.1.1` (CVE-2026-12151, CVE-2026-1526, CVE-2026-2229, CVE-2026-19481).

Downstream impact, only for `amazon-bedrock/*`, `google-vertex/*` and `google-vertex-anthropic/*` models:

- If `GOOGLE_VERTEX_API_KEY` is set, Vertex now uses express mode and ignores `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` and `GOOGLE_APPLICATION_CREDENTIALS`. Unset it if you rely on project credentials.
- Bedrock clamps a `temperature` above `1` to `1` and returns a warning.
