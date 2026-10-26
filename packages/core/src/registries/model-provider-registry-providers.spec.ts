/**
 * Checks that the registry adapters pass env configuration through to the real
 * `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex` and `ollama-ai-provider-v2` packages, so a
 * provider major-version bump that changes how those options are read fails here. The network is
 * faked at `globalThis.fetch` (which all three providers use), and Vertex's Google sign-in is served
 * by a loopback fake of the GCE metadata server, so nothing leaves the machine.
 */
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeStringify } from "@voltagent/internal";
import { generateText } from "ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RecordedRequest = { url: string; headers: Headers };

const json = (body: unknown) =>
  new Response(safeStringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Minimal successful text response for each provider's wire format.
const replyFor = (url: string) => {
  const { host } = new URL(url);
  if (host.startsWith("bedrock-runtime.")) {
    return json({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  }
  if (host.endsWith("aiplatform.googleapis.com")) {
    return json({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }
  return json({
    model: "llama3.2",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: "ok" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 1,
    eval_count: 1,
  });
};

// Strip ambient credentials/config so a developer's real AWS, gcloud or Ollama setup can't leak in.
const AMBIENT_ENV = /^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|GCE_METADATA_|METADATA_SERVER_|OLLAMA_)/;

describe("model provider registry adapters for bundled cloud providers", () => {
  const originalEnv = { ...process.env };
  const emptyGcloudConfig = mkdtempSync(join(tmpdir(), "voltagent-gcloud-"));
  let metadataServer: Server;
  let metadataHost: string;
  let metadataRequests: string[] = [];
  let requests: RecordedRequest[] = [];

  const generateWith = async (modelId: string) => {
    const { ModelProviderRegistry } = await import("./model-provider-registry");
    const model = await ModelProviderRegistry.getInstance().resolveLanguageModel(modelId);
    await generateText({ model, prompt: "hi" });
    expect(requests).toHaveLength(1);
    return requests[0];
  };

  beforeAll(async () => {
    // Stands in for the GCE metadata server so Vertex's application-default-credentials flow
    // resolves an access token over loopback instead of reaching Google.
    metadataServer = createServer((req, res) => {
      metadataRequests.push(req.url ?? "");
      res.setHeader("Metadata-Flavor", "Google");
      if (req.url?.startsWith("/computeMetadata/v1/instance/service-accounts/default/token")) {
        res.setHeader("content-type", "application/json");
        res.end(
          safeStringify({ access_token: "metadata-token", expires_in: 3600, token_type: "Bearer" }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => metadataServer.listen(0, "127.0.0.1", resolve));
    metadataHost = `127.0.0.1:${(metadataServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => metadataServer.close(resolve));
  });

  beforeEach(() => {
    requests = [];
    metadataRequests = [];
    (globalThis as Record<string, unknown>).___voltagent_model_provider_registry = undefined;

    process.env = Object.fromEntries(
      Object.entries(originalEnv).filter(([key]) => !AMBIENT_ENV.test(key)),
    );
    // "production" skips the on-disk models.dev cache and the auto-refresh fetch, keeping the
    // registry on its static entries and the fetch stub free of unrelated traffic.
    process.env.NODE_ENV = "production";
    process.env.CLOUDSDK_CONFIG = emptyGcloudConfig;
    process.env.GCE_METADATA_HOST = metadataHost;
    process.env.METADATA_SERVER_DETECTION = "assume-present";

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      return replyFor(url);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    (globalThis as Record<string, unknown>).___voltagent_model_provider_registry = undefined;
  });

  it("signs Amazon Bedrock requests for AWS_REGION with the AWS_* credentials", async () => {
    Object.assign(process.env, {
      AWS_REGION: "us-west-2",
      AWS_ACCESS_KEY_ID: "AKIDTEST",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      AWS_SESSION_TOKEN: "test-session-token",
    });

    const request = await generateWith("amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0");

    expect(new URL(request.url).host).toBe("bedrock-runtime.us-west-2.amazonaws.com");
    expect(request.headers.get("authorization")).toContain("Credential=AKIDTEST/");
    expect(request.headers.get("x-amz-security-token")).toBe("test-session-token");
  });

  it("calls Vertex for GOOGLE_VERTEX_PROJECT/LOCATION with an application-default-credentials token", async () => {
    Object.assign(process.env, {
      GOOGLE_VERTEX_PROJECT: "test-project",
      GOOGLE_VERTEX_LOCATION: "us-central1",
    });

    const request = await generateWith("google-vertex/gemini-2.0-flash");

    const url = new URL(request.url);
    expect(url.host).toBe("us-central1-aiplatform.googleapis.com");
    expect(url.pathname).toContain(
      "/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:",
    );
    expect(request.headers.get("authorization")).toBe("Bearer metadata-token");
    expect(metadataRequests.some((path) => path.includes("/token"))).toBe(true);
  });

  // New in @ai-sdk/google-vertex v4: an API key switches Vertex to express mode, which ignores
  // project/location and skips application default credentials. v3 ignored the key entirely.
  it("uses Vertex express mode when GOOGLE_VERTEX_API_KEY is set, even with a project configured", async () => {
    Object.assign(process.env, {
      GOOGLE_VERTEX_PROJECT: "test-project",
      GOOGLE_VERTEX_LOCATION: "us-central1",
      GOOGLE_VERTEX_API_KEY: "vertex-express-key",
    });

    const request = await generateWith("google-vertex/gemini-2.0-flash");

    const url = new URL(request.url);
    expect(url.host).toBe("aiplatform.googleapis.com");
    expect(url.pathname).not.toContain("/projects/");
    expect(request.headers.get("x-goog-api-key")).toBe("vertex-express-key");
    expect(request.headers.get("authorization")).toBeNull();
    expect(metadataRequests).toEqual([]);
  });

  it("talks to a local Ollama server at 127.0.0.1:11434 without credentials", async () => {
    const request = await generateWith("ollama/llama3.2");

    expect(request.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(request.headers.get("authorization")).toBeNull();
  });
});
