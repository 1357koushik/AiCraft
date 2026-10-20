import { ILLMProvider, LLMRequest, LLMResponseResult } from '../types/index.js';
import { parseAndValidateLLMResponse } from './parser.js';
import { AppConfig } from '../config/index.js';

export class LMStudioProvider implements ILLMProvider {
  public name = 'lmstudio';
  private config: AppConfig;
  private logger: any;

  constructor(config: AppConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }

  public async generateDecision(request: LLMRequest): Promise<LLMResponseResult> {
    const start = Date.now();
    const endpoint = `${this.config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, any> = {
      model: this.config.llm.model || 'default',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      temperature: this.config.llm.temperature,
      max_tokens: this.config.llm.maxTokens,
    };

    if (this.config.llm.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llm.timeoutMs || 45000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          rawText: '',
          error: `LM Studio API HTTP ${response.status}: ${errorText}`,
          latencyMs: Date.now() - start,
        };
      }

      const data: any = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined;

      const parsed = parseAndValidateLLMResponse(content);
      if (!parsed.success) {
        return {
          rawText: content,
          error: parsed.error,
          tokenUsage: usage,
          latencyMs: Date.now() - start,
        };
      }

      return {
        rawText: content,
        decision: parsed.data,
        tokenUsage: usage,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        rawText: '',
        error: `LM Studio request failed: ${err.message}`,
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
