import { LLMResponseSchema, ValidatedLLMResponse } from '../prompt/schema.js';

export interface ParseResult {
  success: boolean;
  data?: ValidatedLLMResponse;
  rawText: string;
  cleanedText?: string;
  error?: string;
}

export function cleanJsonString(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences like ```json ... ``` or ``` ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    const lastFence = text.lastIndexOf('```');
    if (lastFence !== -1) {
      text = text.substring(0, lastFence);
    }
  }

  text = text.trim();

  // If text starts before the first '{', find the first '{' and the last '}'
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  return text;
}

export function parseAndValidateLLMResponse(rawText: string): ParseResult {
  const cleaned = cleanJsonString(rawText);
  let parsedJson: any;

  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err: any) {
    return {
      success: false,
      rawText,
      cleanedText: cleaned,
      error: `JSON syntax error: ${err.message}`,
    };
  }

  const result = LLMResponseSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      success: false,
      rawText,
      cleanedText: cleaned,
      error: `Schema validation failed: ${JSON.stringify(result.error.format())}`,
    };
  }

  return {
    success: true,
    data: result.data,
    rawText,
    cleanedText: cleaned,
  };
}
