import { AppConfig } from '../config/index.js';
import { ILLMProvider } from '../types/index.js';
import { LMStudioProvider } from './lmstudio.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { MockLLMProvider } from './mock.js';

export function createLLMProvider(config: AppConfig, logger: any): ILLMProvider {
  const providerType = config.llm.provider.toLowerCase();

  // Cloud data boundary check
  if ((providerType === 'openai' || providerType === 'anthropic') && !config.llm.allowCloudFallback) {
    logger.warn(
      `Cloud provider '${providerType}' configured with allowCloudFallback=false. Local operations will proceed with explicit consent.`
    );
  }

  logger.info(`Active LLM provider: ${providerType.toUpperCase()} (model: ${config.llm.model})`);

  switch (providerType) {
    case 'lmstudio':
      return new LMStudioProvider(config, logger);
    case 'openai':
      return new OpenAIProvider(config, logger);
    case 'anthropic':
      return new AnthropicProvider(config, logger);
    case 'mock':
      return new MockLLMProvider();
    default:
      logger.warn(`Unknown provider '${providerType}', falling back to MockLLMProvider`);
      return new MockLLMProvider();
  }
}

export * from './parser.js';
export * from './mock.js';
export * from './lmstudio.js';
export * from './openai.js';
export * from './anthropic.js';
