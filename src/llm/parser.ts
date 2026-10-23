import { LLMResponseSchema, ValidatedLLMResponse, ACTION_ALLOWED_PARAMS } from '../prompt/schema.js';

export interface ParseResult {
  success: boolean;
  data?: ValidatedLLMResponse;
  rawText: string;
  cleanedText?: string;
  error?: string;
}

/**
 * Strips reasoning tokens enclosed in <think>...</think> tags if present.
 */
export function stripThinkTags(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
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
 * string literals, escaped quotation marks, and stray quotes in preceding prose.
 * Returns all valid candidate JSON objects found in the string.
 */
export function extractAllBalancedJsonObjects(text: string): string[] {
  const parseWithStrategy = (input: string, resetStringOnNewline: boolean): string[] => {
    const candidates: string[] = [];
    let startIndex = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (resetStringOnNewline && depth === 0 && (char === '\n' || char === '\r')) {
        inString = false;
        escapeNext = false;
      }

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
              const candidate = input.substring(startIndex, i + 1);
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
  };

  // Strategy 1: Scan with newline string boundary reset at depth 0
  let candidates = parseWithStrategy(text, true);
  if (candidates.length > 0) return candidates;

  // Strategy 2: If code fences exist, extract content within fences first
  const stripped = stripCodeFences(text);
  if (stripped !== text) {
    candidates = parseWithStrategy(stripped, true);
    if (candidates.length > 0) return candidates;
  }

  // Strategy 3: Fallback scan from every '{' assuming stray unescaped quotes in preceding prose
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const subCandidates = parseWithStrategy(text.substring(i), false);
      if (subCandidates.length > 0) {
        return subCandidates;
      }
    }
  }

  return [];
}

/**
 * Scans a string for balanced JSON objects and checks for multiple conflicting candidates.
 * If multiple conflicting candidates satisfy LLMResponseSchema, flags ambiguity.
 */
export function resolveBalancedJsonObject(text: string): { candidate: string | null; ambiguous: boolean } {
  const candidates = extractAllBalancedJsonObjects(text);
  if (candidates.length === 0) return { candidate: null, ambiguous: false };

  const validDecisions: { candidate: string; parsed: any }[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const res = LLMResponseSchema.safeParse(parsed);
      if (res.success) {
        validDecisions.push({ candidate, parsed });
      }
    } catch {}
  }

  if (validDecisions.length > 1) {
    // Check if conflicting decisions exist (e.g. different decision_summary or actions)
    const firstStr = JSON.stringify(validDecisions[0].parsed.actions);
    const hasConflict = validDecisions.some(
      (v) => JSON.stringify(v.parsed.actions) !== firstStr || v.parsed.decision_summary !== validDecisions[0].parsed.decision_summary
    );
    if (hasConflict) {
      return { candidate: null, ambiguous: true };
    }
  }

  if (validDecisions.length > 0) {
    return { candidate: validDecisions[0].candidate, ambiguous: false };
  }

  // Second priority: find a candidate with decision_summary and actions
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && ('decision_summary' in parsed || 'actions' in parsed)) {
        return { candidate, ambiguous: false };
      }
    } catch {}
  }

  // Fallback: return the first valid JSON object
  return { candidate: candidates[0] || null, ambiguous: false };
}

/**
 * Finds the first balanced JSON object in the string that either satisfies
 * the full LLMResponseSchema, or falls back to the first valid JSON object.
 */
export function extractFirstBalancedJsonObject(text: string): string | null {
  const res = resolveBalancedJsonObject(text);
  return res.candidate;
}

/**
 * Cleans the input string by extracting fenced blocks or balanced JSON objects.
 */
export function cleanJsonString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const noThink = stripThinkTags(raw);
  const text = noThink.length > 0 ? noThink : raw;
  const trimmed = text.trim();
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
 * Normalizes raw decision JSON from local/open-source LLMs before schema validation:
 * - Normalizes common action aliases (e.g. mine_block -> mine_resource/dig_block, walk -> goto)
 * - Moves misplaced top-level parameters into `params`
 * - Strips prompt catalog metadata like `category`, `desc`, `choices` from action objects
 */
export function normalizeRawDecisionJson(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;

  if (!obj.goal || typeof obj.goal !== 'string' || obj.goal.trim() === '') {
    obj.goal = 'Survive and gather resources';
  }

  if (
    !obj.decision_summary ||
    typeof obj.decision_summary !== 'string' ||
    obj.decision_summary.trim() === ''
  ) {
    const firstAct = Array.isArray(obj.actions) && obj.actions[0] ? obj.actions[0].action : null;
    obj.decision_summary = firstAct ? `Executing ${firstAct}` : 'Assessing surroundings and surviving';
  }

  if (Array.isArray(obj.actions)) {
    obj.actions = obj.actions.map((act: any) => {
      if (typeof act !== 'object' || act === null) return act;

      let actionName = act.action;
      if (typeof actionName === 'string') {
        const lower = actionName.toLowerCase().trim();
        if (lower === 'mine_block') {
          actionName = act.x !== undefined || act.params?.x !== undefined ? 'dig_block' : 'mine_resource';
        } else if (lower === 'break_block') {
          actionName = 'dig_block';
        } else if (lower === 'mine') {
          actionName = 'mine_resource';
        } else if (lower === 'chop_wood' || lower === 'gather_wood' || lower === 'get_wood' || lower === 'harvest_tree') {
          actionName = 'chop_tree';
        } else if (lower === 'mine_stone' || lower === 'gather_stone' || lower === 'get_stone') {
          actionName = 'collect_resource';
          if (!act.params?.resource) act.params = { ...(act.params || {}), resource: 'stone', count: act.params?.count || 8 };
        } else if (lower === 'craft_tool' || lower === 'craft_pickaxe') {
          actionName = 'craft_item';
        } else if (lower === 'walk' || lower === 'walk_to') {
          actionName = 'goto';
        } else if (lower === 'run') {
          actionName = 'sprint';
        } else if (lower === 'idle') {
          actionName = 'wait';
        } else if (lower === 'say') {
          actionName = 'chat';
        } else {
          actionName = lower;
        }
      }

      const params = { ...(act.params || {}) };
      const allowedKeys = (ACTION_ALLOWED_PARAMS as any)[actionName] || [];

      // If model placed allowed parameters directly on the action root, move them into params
      for (const k of Object.keys(act)) {
        if (k === 'action' || k === 'params') continue;
        if (allowedKeys.includes(k) && params[k] === undefined) {
          params[k] = act[k];
        }
      }

      // Default common missing required strings for actions
      if (
        (actionName === 'mine_resource' || actionName === 'dig_block') &&
        (!params.blockType || typeof params.blockType !== 'string' || params.blockType.trim() === '')
      ) {
        params.blockType = 'dirt';
      }
      if (
        actionName === 'chop_tree' &&
        (!params.logType || typeof params.logType !== 'string' || params.logType.trim() === '')
      ) {
        params.logType = 'oak_log';
      }
      if (
        actionName === 'chat' &&
        (!params.message || typeof params.message !== 'string' || params.message.trim() === '')
      ) {
        params.message = 'Hello';
      }
      if (actionName === 'wait' && (!params.seconds || typeof params.seconds !== 'number')) {
        params.seconds = 1;
      }

      // Clean empty/null/undefined string keys that would fail string validation
      for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
          delete params[k];
        }
      }

      // If model used cardinal direction for 'move', normalize to 'explore'
      if (actionName === 'move' && ['north', 'south', 'east', 'west'].includes(params.direction)) {
        actionName = 'explore';
      }
      // If model used relative direction for 'explore', normalize to 'move'
      if (actionName === 'explore' && ['forward', 'back', 'left', 'right'].includes(params.direction)) {
        actionName = 'move';
      }

      // Return clean action object conforming strictly to { action, params }
      return {
        action: actionName,
        params,
      };
    });
  }

  return obj;
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

  const noThink = stripThinkTags(rawText);
  const targetText = noThink.length > 0 ? noThink : rawText;
  const trimmed = targetText.trim();
  const stripped = stripCodeFences(trimmed);
  const resolution = resolveBalancedJsonObject(stripped);
  if (resolution.ambiguous) {
    return {
      success: false,
      rawText,
      error: 'Ambiguous response: multiple conflicting valid JSON decisions found in model output.',
    };
  }

  const cleaned = cleanJsonString(targetText);
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

  parsedJson = normalizeRawDecisionJson(parsedJson);

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
