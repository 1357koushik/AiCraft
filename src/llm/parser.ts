import { LLMResponseSchema, ValidatedLLMResponse } from '../prompt/schema.js';

export interface ParseResult {
  success: boolean;
  data?: ValidatedLLMResponse;
  rawText: string;
  cleanedText?: string;
  error?: string;
}

/**
 * Extracts markdown code fences if present anywhere in the raw text.
 * Handles patterns like:
 * ```json
 * { ... }
 * ```
 */
export function stripCodeFences(raw: string): string {
  const text = raw.trim();
  // Check for fenced code block anywhere in text
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  // Otherwise if starts with ``` but unclosed
  if (text.startsWith('```')) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return text;
}

/**
 * Scans a string for balanced JSON objects `{ ... }`, properly respecting
 * string literals and escaped quotation marks.
 * Returns all valid candidate JSON objects found in the string.
 */
export function extractAllBalancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
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
              candidates.push(candidate);
            } catch {
              // Not valid standalone JSON
            }
            startIndex = -1;
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * Finds the first balanced JSON object in the string that either satisfies
 * the full LLMResponseSchema, or falls back to the first valid JSON object.
 */
export function extractFirstBalancedJsonObject(text: string): string | null {
  const candidates = extractAllBalancedJsonObjects(text);
  if (candidates.length === 0) return null;

  // First priority: find a candidate that parses and satisfies LLMResponseSchema
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const res = LLMResponseSchema.safeParse(parsed);
      if (res.success) {
        return candidate;
      }
    } catch {}
  }

  // Second priority: find a candidate with decision_summary and actions
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && ('decision_summary' in parsed || 'actions' in parsed)) {
        return candidate;
      }
    } catch {}
  }

  // Fallback: return the first valid JSON object
  return candidates[0] || null;
}

/**
 * Cleans the input string by extracting fenced blocks or balanced JSON objects.
 */
export function cleanJsonString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';

  // 1. Try stripping code fences first
  const fenced = stripCodeFences(trimmed);
  if (fenced !== trimmed) {
    const balancedInFence = extractFirstBalancedJsonObject(fenced);
    if (balancedInFence) return balancedInFence;
    return fenced;
  }

  // 2. Try finding balanced JSON in raw string
  const balanced = extractFirstBalancedJsonObject(trimmed);
  return balanced || trimmed;
}

/**
 * Parses and validates an LLM response against LLMResponseSchema.
 * Guarantees that:
 * - Empty, whitespace, or non-string inputs fail gracefully without throwing.
 * - JSON syntax errors are cleanly caught and reported.
 * - Schema validation fails on missing fields, unknown actions, invalid structures.
 * - Never evaluates model-generated text or executes code.
 */
export function parseAndValidateLLMResponse(rawText: string): ParseResult {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return {
      success: false,
      rawText: rawText || '',
      error: 'Empty or missing response from LLM provider',
    };
  }

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

  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return {
      success: false,
      rawText,
      cleanedText: cleaned,
      error: 'Expected JSON object at root of response',
    };
  }

  const result = LLMResponseSchema.safeParse(parsedJson);
  if (!result.success) {
    const formattedErrors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return {
      success: false,
      rawText,
      cleanedText: cleaned,
      error: `Schema validation failed: ${formattedErrors}`,
    };
  }

  return {
    success: true,
    data: result.data,
    rawText,
    cleanedText: cleaned,
  };
}
