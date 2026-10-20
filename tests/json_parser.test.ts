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

  it('handles braces inside string literals and escaped quotes correctly', () => {
    const raw = `
    Here is an answer with {explanatory braces}:
    {
      "decision_summary": "Looking at {special} tree \\"oak\\" with leaves",
      "goal": "Collect wood",
      "actions": [{"action": "wait", "params": {}}]
    }
    End of message {extra}`;
    const parsed = parseAndValidateLLMResponse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.decision_summary).toContain('{special}');
  });

  it('rejects JSON missing required fields', () => {
    const invalid = '{"decision_summary": "missing goal and actions"}';
    const parsed = parseAndValidateLLMResponse(invalid);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Schema validation failed');
  });

  it('rejects invalid or hallucinated action names not in registry', () => {
    const invalidAction = JSON.stringify({
      decision_summary: "Let's fly away",
      goal: "Fly around",
      actions: [{ action: "fly_away_into_sky", params: {} }]
    });
    const parsed = parseAndValidateLLMResponse(invalidAction);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Invalid action name');
  });

  it('rejects empty actions array', () => {
    const emptyActions = JSON.stringify({
      decision_summary: "Do nothing",
      goal: "Idle",
      actions: []
    });
    const parsed = parseAndValidateLLMResponse(emptyActions);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('actions must contain at least 1 action');
  });

  it('rejects actions exceeding maximum allowed limit (5)', () => {
    const tooManyActions = JSON.stringify({
      decision_summary: "Chain 6 actions",
      goal: "Speedrun",
      actions: [
        { action: "wait", params: {} },
        { action: "wait", params: {} },
        { action: "wait", params: {} },
        { action: "wait", params: {} },
        { action: "wait", params: {} },
        { action: "wait", params: {} },
      ]
    });
    const parsed = parseAndValidateLLMResponse(tooManyActions);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('actions cannot exceed 5 actions');
  });

  it('rejects unexpected structures or unrecognized properties due to strict mode', () => {
    const unexpectedProps = JSON.stringify({
      decision_summary: "Valid decision",
      goal: "Valid goal",
      actions: [{ action: "wait", params: {} }],
      maliciousPayload: "system('rm -rf /')"
    });
    const parsed = parseAndValidateLLMResponse(unexpectedProps);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Unrecognized key(s)');
  });

  it('handles empty response, whitespace, or null gracefully without crashing', () => {
    expect(parseAndValidateLLMResponse("").success).toBe(false);
    expect(parseAndValidateLLMResponse("   \n\t  ").success).toBe(false);
    expect(parseAndValidateLLMResponse(null as any).success).toBe(false);
  });

  it('handles truncated JSON without throwing an unhandled exception', () => {
    const truncated = '{"decision_summary": "Looking at tree", "goal": "Cho';
    const parsed = parseAndValidateLLMResponse(truncated);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('JSON syntax error');
  });

  it('extracts schema-matching JSON when multiple balanced JSON objects appear in prose', () => {
    const multipleObjects = `
    First I thought of returning { "status": "draft", "options": [1, 2] }.
    Then I considered { "error": null }.
    Finally, here is the official action plan:
    {
      "decision_summary": "Valid plan after discussion",
      "goal": "Build shelter",
      "actions": [{"action": "build_shelter", "params": {}}]
    }
    Hope that helps!
    `;
    const parsed = parseAndValidateLLMResponse(multipleObjects);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.actions[0].action).toBe('build_shelter');
  });

  it('correctly parses complex nested memory objects', () => {
    const validWithMemory = JSON.stringify({
      decision_summary: "Marking base location",
      goal: "Setup home base",
      actions: [{ action: "remember", params: { key: "home", value: "base camp" } }],
      memory: {
        note: "Safe area with coal deposits",
        namedLocation: {
          name: "home",
          position: { x: 120, y: 64, z: -250 }
        },
        dangerZone: {
          name: "creeper_ravine",
          position: { x: 150, y: 30, z: -200 },
          radius: 15
        }
      },
      say: "Home established!"
    });
    const parsed = parseAndValidateLLMResponse(validWithMemory);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.memory?.namedLocation?.name).toBe('home');
    expect(parsed.data?.memory?.dangerZone?.radius).toBe(15);
    expect(parsed.data?.say).toBe('Home established!');
  });
});
