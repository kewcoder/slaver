// AI provider: Meta Model API (Muse Spark), which speaks the OpenAI Chat Completions
// protocol. Any other OpenAI-compatible endpoint also works via AI_BASE_URL.
// When not configured, ads fall back to templates and the camera reports it is unavailable.

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  textModel: string;
  visionModel: string;
}

export function aiFromEnv(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const key = env.AI_API_KEY || env.MODEL_API_KEY;
  if (!key) return null;
  return {
    baseUrl: (env.AI_BASE_URL || "https://api.meta.ai/v1").replace(/\/+$/, ""),
    apiKey: key,
    textModel: env.AI_TEXT_MODEL || "muse-spark-1.3",
    visionModel: env.AI_VISION_MODEL || "muse-spark-1.3",
  };
}

type Content = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

// Calls chat/completions and returns the parsed JSON message content.
export async function chatJson(
  cfg: AiConfig,
  model: string,
  messages: { role: "system" | "user"; content: Content }[],
): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, temperature: 0.4 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AI provider returned ${res.status}`);
  const body: any = await res.json();
  const text: string | undefined = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI provider returned no content");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI provider returned non-JSON content");
  }
}
