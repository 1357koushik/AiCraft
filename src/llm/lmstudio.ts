import { ILLMProvider, LLMRequest, LLMResponseResult } from '../types/index.js';
import { parseAndValidateLLMResponse } from './parser.js';
import { AppConfig } from '../config/index.js';
import { LLMJsonSchemaObject } from '../prompt/schema.js';

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

    const makeBody = (useJsonSchema: boolean) => {
      const body: Record<string, any> = {
        model: this.config.llm.model || 'default',
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        temperature: this.config.llm.temperature,
        max_tokens: this.config.llm.maxTokens,
      };

      if (this.config.llm.jsonMode && useJsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'minecraft_agent_decision',
            strict: true,
            schema: LLMJsonSchemaObject,
          },
        };
      }
      return body;
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llm.timeoutMs || 45000);

    try {
      let body = makeBody(true);
      let response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // If LM Studio rejects json_schema or fails sampler/grammar init, fallback cleanly without response_format
      if (!response.ok && this.config.llm.jsonMode && (response.status === 400 || response.status === 500)) {
        const errPeek = await response.text();
        this.logger?.warn?.(
          `LM Studio structured output / grammar sampler failed (${response.status}: ${errPeek}). Retrying without response_format constraint...`
        );
        body = makeBody(false);
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        return {
          rawText: '',
          error: `LM Studio API HTTP ${response.status}: ${errorText}`,
          latencyMs: Date.now() - start,
        };
      }

      const data: any = await response.json();
      const message = data.choices?.[0]?.message;
      let content = (message?.content || '').trim();
      // Handle reasoning models where output might reside in reasoning_content
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
        console.log(`[LLM_PARSER_ERROR] Failed to parse model output: ${parsed.error}\nRaw text preview: ${content.slice(0, 250)}...`);
        return {
          rawText: content,
          error: parsed.error || 'Failed to parse decision data',
          tokenUsage: usage,
          latencyMs: Date.now() - start,
        };
      }

      console.log(`[LLM_SUCCESS] Response in ${Date.now() - start}ms (${usage?.totalTokens ?? 'N/A'} tokens). Goal: "${parsed.data.goal}" | Decision: "${parsed.data.decision_summary}"`);
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
