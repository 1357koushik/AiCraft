import { loadConfig } from '../config/index.js';

/**
 * A plain chat client for the decision loop: one system prompt, one user message, text back.
 * Uses the provider in config/config.yaml (an OpenAI-compatible endpoint such as Gemini's, or Anthropic).
 * Kept separate from src/llm/, which is built around the old one-action-per-second decision schema.
 */

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ChatClient {
  readonly model: string;
  complete(system: string, user: string): Promise<ChatResult>;
}

/**
 * Retries a call on failures that are usually brief: network errors, timeouts, rate limits (429) and server
 * errors (5xx). Client errors such as a bad key (4xx) fail at once. Backoff: 1 s, 3 s, 9 s.
 */
async function withRetry(call: () => Promise<ChatResult>, attempts = 4): Promise<ChatResult> {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (err) {
      last = err as Error;
      const msg = last.message ?? '';
      const status = Number(msg.match(/(\d{3}):/)?.[1] ?? 0);
      const transient = status === 429 || status >= 500 || status === 0 || /fetch failed|timeout|aborted|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket/i.test(msg);
      if (!transient || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * 3 ** i));
    }
  }
  throw last ?? new Error('LLM call failed');
}

export function createChatClient(overrides: { model?: string } = {}): ChatClient {
  const config = loadConfig();
  const llm: any = config.llm;
  const provider = String(llm.provider).toLowerCase();
  const model = overrides.model ?? llm.model;
  const apiKey = llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : undefined;
  const timeoutMs = llm.timeoutMs ?? 60000;
  const temperature = llm.temperature ?? 0.3;
  const maxTokens = Math.max(llm.maxTokens ?? 1024, 1500);

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY ?? apiKey;
    return {
      model,
      complete: (system, user) => withRetry(async () => {
        const started = Date.now();
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const j: any = await res.json();
        const text = (j.content ?? []).map((c: any) => c.text ?? '').join('');
        return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0, latencyMs: Date.now() - started };
      }),
    };
  }

  const baseUrl = String(llm.baseUrl ?? 'http://localhost:1234/v1').replace(/\/$/, '');
  return {
    model,
    complete: (system, user) => withRetry(async () => {
      const started = Date.now();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j: any = await res.json();
      const text = j.choices?.[0]?.message?.content ?? '';
      return { text, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0, latencyMs: Date.now() - started };
    }),
  };
}
