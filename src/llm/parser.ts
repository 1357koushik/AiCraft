import { LLMResponseSchema, ValidatedLLMResponse } from '../prompt/schema.js';

export interface ParseResult {
  success: boolean;
  data?: ValidatedLLMResponse;
  rawText: string;
  cleanedText?: string;
  error?: string;
}

/**
 * Strips markdown code fences from the input string.
 */
export function stripCodeFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    const lastFence = text.lastIndexOf('```');
    if (lastFence !== -1) {
      text = text.substring(0, lastFence);
    }
  }
  return text.trim();
}

/**
 * Finds a valid balanced JSON object {...} in a string,
 * correctly ignoring braces inside string literals and escaped quotes.
 * If multiple balanced blocks exist (e.g. conversational braces), it iterates
 * until finding one that parses as a valid JSON object.
 */
export function extractFirstBalancedJsonObject(text: string): string | null {
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (char === '}') {
        if (depth > 0) {
          depth--;
          if (depth === 0 && startIndex !== -1) {
            const candidate = text.substring(startIndex, i + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch {
              // Not valid JSON, continue scanning forward from the current position
              startIndex = -1;
            }
          }
        }
      }
    }
  }

  return null;
}

export function cleanJsonString(raw: string): string {
  const stripped = stripCodeFences(raw);
  const balanced = extractFirstBalancedJsonObject(stripped);
  return balanced || stripped;
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
