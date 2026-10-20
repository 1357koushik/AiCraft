import { describe, it, expect } from 'vitest';
import { cleanJsonString, parseAndValidateLLMResponse } from '../src/llm/parser.js';

describe('LLM JSON Parser and Cleaner', () => {
  it('cleans markdown code fences', () => {
    const raw = "```json\n{\n  \"decision_summary\": \"test\",\n  \"goal\": \"test\",\n  \"actions\": [{\"action\": \"wait\", \"params\": {}}]\n}\n```";
    const cleaned = cleanJsonString(raw);
    expect(cleaned.startsWith('{')).toBe(true);
    expect(cleaned.endsWith('}')).toBe(true);
  });

  it('extracts JSON object when surrounded by conversational text', () => {
    const raw = "Here is my decision:\n{\n  \"decision_summary\": \"gathering wood\",\n  \"goal\": \"collect 3 logs\",\n  \"actions\": [{\"action\": \"mine_resource\", \"params\": {\"blockType\": \"oak_log\"}}]\n}\nHope this helps!";
    const cleaned = cleanJsonString(raw);
    const parsed = parseAndValidateLLMResponse(cleaned);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.actions[0].action).toBe('mine_resource');
  });

  it('rejects JSON missing required fields', () => {
    const invalid = '{"decision_summary": "missing goal and actions"}';
    const parsed = parseAndValidateLLMResponse(invalid);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Schema validation failed');
  });
});
