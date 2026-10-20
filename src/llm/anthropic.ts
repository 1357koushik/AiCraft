import { ILLMProvider, LLMRequest, LLMResponseResult } from '../types/index.js';
import { parseAndValidateLLMResponse } from './parser.js';
import { AppConfig } from '../config/index.js';

export class AnthropicProvider implements ILLMProvider {
  public name = 'anthropic';
  private config: AppConfig;
  private logger: any;

  constructor(config: AppConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }

  public async generateDecision(request: LLMRequest): Promise<LLMResponseResult> {
    const start = Date.now();
    const apiKey = process.env[this.config.llm.apiKeyEnv || 'ANTHROPIC_API_KEY'];

    if (!apiKey) {
      return {
        rawText: '',
        error: `Missing API key in environment variable ${this.config.llm.apiKeyEnv || 'ANTHROPIC_API_KEY'}`,
        latencyMs: 0,
      };
    }

    const endpoint = 'https://api.anthropic.com/v1/messages';

    const body = {
      model: this.config.llm.model || 'claude-3-5-sonnet-20241022',
      system: request.systemPrompt + '\n\nIMPORTANT: Respond ONLY with a valid JSON object matching the required schema.',
      messages: [{ role: 'user', content: request.userPrompt }],
      max_tokens: this.config.llm.maxTokens,
      temperature: this.config.llm.temperature,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llm.timeoutMs || 45000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          rawText: '',
          error: `Anthropic API HTTP ${response.status}: ${errorText}`,
          latencyMs: Date.now() - start,
        };
      }

      const data: any = await response.json();
      const content = data.content?.[0]?.text || '';
      const usage = data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
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
        error: `Anthropic request failed: ${err.message}`,
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
