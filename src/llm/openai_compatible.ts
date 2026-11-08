import { ILLMProvider, LLMRequest, LLMResponseResult } from '../types/index.js';
import { parseAndValidateLLMResponse } from './parser.js';
import { AppConfig } from '../config/index.js';
import { LLMJsonSchemaObject } from '../prompt/schema.js';

export interface OpenAICompatibleOptions {
  /** Provider name used in logs and error messages. */
  name: string;
  label: string;
  defaultBaseUrl?: string;
  defaultModel: string;
  /** When set, the API key is read from this env var (or config.llm.apiKeyEnv) and is required. */
  defaultApiKeyEnv?: string;
  /**
   * 'json_object' asks for any JSON object. 'json_schema' asks for the decision schema and
   * retries once without response_format if the server rejects it (LM Studio grammar failures).
   */
  jsonFormat: 'json_object' | 'json_schema';
}

/**
 * Client for any server exposing the OpenAI /chat/completions API (OpenAI, LM Studio, etc.).
 */
export class OpenAICompatibleProvider implements ILLMProvider {
  public name: string;
  protected config: AppConfig;
  protected logger: any;
  private options: OpenAICompatibleOptions;

  constructor(config: AppConfig, logger: any, options: OpenAICompatibleOptions) {
    this.config = config;
    this.logger = logger;
    this.options = options;
    this.name = options.name;
  }

  private buildBody(request: LLMRequest, withResponseFormat: boolean): Record<string, any> {
    const body: Record<string, any> = {
      model: this.config.llm.model || this.options.defaultModel,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      temperature: this.config.llm.temperature,
      max_tokens: this.config.llm.maxTokens,
    };
    if (this.config.llm.jsonMode && withResponseFormat) {
      body.response_format =
        this.options.jsonFormat === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: { name: 'minecraft_agent_decision', strict: true, schema: LLMJsonSchemaObject },
            }
          : { type: 'json_object' };
    }
    return body;
  }

  public async generateDecision(request: LLMRequest): Promise<LLMResponseResult> {
    const start = Date.now();
    const { label } = this.options;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.defaultApiKeyEnv) {
      const envName = this.config.llm.apiKeyEnv || this.options.defaultApiKeyEnv;
      const apiKey = process.env[envName];
      if (!apiKey) {
        return { rawText: '', error: `Missing API key in environment variable ${envName}`, latencyMs: 0 };
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const baseUrl = this.config.llm.baseUrl || this.options.defaultBaseUrl || '';
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llm.timeoutMs || 45000);
    const post = (body: Record<string, any>) =>
      fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });

    try {
      let response = await post(this.buildBody(request, true));

      // Some local servers reject json_schema or fail grammar init; retry once without it.
      if (
        !response.ok &&
        this.config.llm.jsonMode &&
        this.options.jsonFormat === 'json_schema' &&
        (response.status === 400 || response.status === 500)
      ) {
        const errPeek = await response.text();
        this.logger?.warn?.(
          `${label} structured output failed (${response.status}: ${errPeek}). Retrying without response_format...`
        );
        response = await post(this.buildBody(request, false));
      }

      if (!response.ok) {
        const errorText = await response.text();
        return { rawText: '', error: `${label} API HTTP ${response.status}: ${errorText}`, latencyMs: Date.now() - start };
      }

      const data: any = await response.json();
      const message = data.choices?.[0]?.message;
      let content = (message?.content || '').trim();
      // Reasoning models may put their output in reasoning_content.
      if (!content && message?.reasoning_content) {
        content = message.reasoning_content.trim();
      }

      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined;

      const parsed = parseAndValidateLLMResponse(content);
      if (!parsed.success || !parsed.data) {
        this.logger?.warn?.(`[LLM_PARSER_ERROR] ${parsed.error}. Raw text preview: ${content.slice(0, 250)}...`);
        return {
          rawText: content,
          error: parsed.error || 'Failed to parse decision data',
          tokenUsage: usage,
          latencyMs: Date.now() - start,
        };
      }

      return { rawText: content, decision: parsed.data, tokenUsage: usage, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { rawText: '', error: `${label} request failed: ${err.message}`, latencyMs: Date.now() - start };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Local LM Studio server (no API key, schema-constrained output with fallback). */
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(config: AppConfig, logger: any) {
    super(config, logger, { name: 'lmstudio', label: 'LM Studio', defaultModel: 'default', jsonFormat: 'json_schema' });
  }
}

/** OpenAI cloud API. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: AppConfig, logger: any) {
    super(config, logger, {
      name: 'openai',
      label: 'OpenAI',
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      defaultApiKeyEnv: 'OPENAI_API_KEY',
      jsonFormat: 'json_object',
    });
  }
}
