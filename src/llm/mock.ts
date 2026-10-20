import { ILLMProvider, LLMRequest, LLMResponseResult, LLMDecision } from '../types/index.js';

export class MockLLMProvider implements ILLMProvider {
  public name = 'mock';
  private scriptedResponses: LLMDecision[] = [];
  private stepCount = 0;

  constructor(scripted?: LLMDecision[]) {
    if (scripted && scripted.length > 0) {
      this.scriptedResponses = [...scripted];
    }
  }

  public setScript(responses: LLMDecision[]): void {
    this.scriptedResponses = [...responses];
    this.stepCount = 0;
  }

  public async generateDecision(request: LLMRequest): Promise<LLMResponseResult> {
    const start = Date.now();

    // If scripted responses are provided, return next in script
    if (this.scriptedResponses.length > 0) {
      const idx = Math.min(this.stepCount++, this.scriptedResponses.length - 1);
      const dec = this.scriptedResponses[idx];
      return {
        rawText: JSON.stringify(dec),
        decision: dec,
        tokenUsage: { promptTokens: 150, completionTokens: 50, totalTokens: 200 },
        latencyMs: Date.now() - start,
      };
    }

    // Default intelligent mock response: inspect userPrompt text to decide
    let decision: LLMDecision = {
      decision_summary: 'Observing surroundings and waiting.',
      goal: 'Explore and survive',
      actions: [{ action: 'wait', params: { seconds: 2 } }],
      say: null,
    };

    if (request.userPrompt.includes('"oak_log"') || request.userPrompt.includes('log')) {
      decision = {
        decision_summary: 'Wood is visible nearby. Collect oak logs.',
        goal: 'Gather logs to craft tools',
        actions: [{ action: 'mine_resource', params: { blockType: 'oak_log', count: 3 } }],
        say: 'Gathering some wood!',
      };
    } else if (request.userPrompt.includes('food') && request.userPrompt.includes('"apple"')) {
      decision = {
        decision_summary: 'Hungry and have apples. Eat an apple.',
        goal: 'Survive and restore hunger',
        actions: [{ action: 'eat', params: { item: 'apple' } }],
      };
    }

    return {
      rawText: JSON.stringify(decision),
      decision,
      tokenUsage: { promptTokens: 180, completionTokens: 45, totalTokens: 225 },
      latencyMs: Date.now() - start,
    };
  }
}
