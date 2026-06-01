import { describe, expect, it } from 'vitest';

import {
  scanRunEventsForUsageAnalytics,
  summarizeRunTimingAnalytics,
} from '../src/run-analytics-observability.js';

describe('scanRunEventsForUsageAnalytics', () => {
  it('extracts provider usage, cache tokens, and estimated context tokens', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: { type: 'status', label: 'initializing', model: 'claude-opus-4' },
        },
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cache_read_input_tokens: 250,
              cache_creation_input_tokens: 100,
            },
          },
        },
      ],
      '',
      40,
    );

    expect(result).toMatchObject({
      input_tokens: 1000,
      input_tokens_provider: 1000,
      input_tokens_effective: 1350,
      output_tokens: 50,
      total_tokens: 1400,
      cache_read_input_tokens: 250,
      cache_creation_input_tokens: 100,
      uncached_input_tokens: 1000,
      estimated_context_tokens: 1310,
      cache_token_source: 'anthropic',
      token_count_source: 'provider_usage',
      agent_reported_model: 'claude-opus-4',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(250 / 1350);
  });

  it('reads OpenAI-style cached prompt token details', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              prompt_tokens: 200,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 80 },
            },
          },
        },
      ],
      'gpt-4o',
      0,
    );

    expect(result.cache_read_input_tokens).toBe(80);
    expect(result.input_tokens_effective).toBe(200);
    expect(result.uncached_input_tokens).toBe(120);
    expect(result.cache_token_source).toBe('openai');
    expect(result.cache_hit_ratio).toBe(0.4);
  });

  it('does not invent cache split fields when provider usage lacks cache data', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 300,
              output_tokens: 30,
            },
          },
        },
      ],
      '',
      10,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 300,
      input_tokens_effective: 300,
      output_tokens: 30,
      total_tokens: 330,
      estimated_context_tokens: 290,
      cache_token_source: 'unavailable',
    });
    expect(result.cache_read_input_tokens).toBeUndefined();
    expect(result.uncached_input_tokens).toBeUndefined();
    expect(result.cache_hit_ratio).toBeUndefined();
  });

  it('treats normalized cached_read_tokens / cached_write_tokens aliases as input subsets', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 400,
              output_tokens: 20,
              cached_read_tokens: 120,
              cached_write_tokens: 30,
            },
          },
        },
      ],
      'gpt-5',
      0,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 400,
      input_tokens_effective: 400,
      output_tokens: 20,
      total_tokens: 420,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 30,
      uncached_input_tokens: 280,
      cache_token_source: 'openai',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(120 / 400);
  });

  it('preserves ACP provider totals when cache read tokens are already included in input', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 31_711,
              output_tokens: 30,
              cached_read_tokens: 2_560,
              thought_tokens: 20,
              total_tokens: 31_741,
            },
          },
        },
      ],
      '',
      0,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 31_711,
      input_tokens_effective: 31_711,
      output_tokens: 30,
      total_tokens: 31_741,
      cache_read_input_tokens: 2_560,
      uncached_input_tokens: 29_151,
      cache_token_source: 'openai',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(2_560 / 31_711);
  });

  it.each([
    {
      name: 'claude anthropic usage',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
      expected: {
        input_tokens_provider: 100,
        input_tokens_effective: 125,
        output_tokens: 10,
        total_tokens: 135,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_token_source: 'anthropic',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'codex cached input usage',
      usage: {
        input_tokens: 200,
        output_tokens: 11,
        cached_input_tokens: 40,
      },
      expected: {
        input_tokens_provider: 200,
        input_tokens_effective: 200,
        output_tokens: 11,
        total_tokens: 211,
        cache_read_input_tokens: 40,
        uncached_input_tokens: 160,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'opencode normalized cache usage',
      usage: {
        input_tokens: 300,
        output_tokens: 12,
        cached_read_tokens: 60,
        cached_write_tokens: 7,
      },
      expected: {
        input_tokens_provider: 300,
        input_tokens_effective: 300,
        output_tokens: 12,
        total_tokens: 312,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 7,
        uncached_input_tokens: 240,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'gemini cached usage',
      usage: {
        input_tokens: 400,
        output_tokens: 13,
        cached_read_tokens: 80,
      },
      expected: {
        input_tokens_provider: 400,
        input_tokens_effective: 400,
        output_tokens: 13,
        total_tokens: 413,
        cache_read_input_tokens: 80,
        uncached_input_tokens: 320,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'cursor cache usage',
      usage: {
        input_tokens: 500,
        output_tokens: 14,
        cached_read_tokens: 90,
        cached_write_tokens: 8,
      },
      expected: {
        input_tokens_provider: 500,
        input_tokens_effective: 500,
        output_tokens: 14,
        total_tokens: 514,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 8,
        uncached_input_tokens: 410,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'acp hermes cache usage',
      usage: {
        input_tokens: 600,
        output_tokens: 15,
        cached_read_tokens: 120,
        total_tokens: 615,
      },
      expected: {
        input_tokens_provider: 600,
        input_tokens_effective: 600,
        output_tokens: 15,
        total_tokens: 615,
        cache_read_input_tokens: 120,
        uncached_input_tokens: 480,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'amr vela usage without cache',
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
      },
      expected: {
        input_tokens_provider: 12,
        input_tokens_effective: 12,
        output_tokens: 7,
        total_tokens: 19,
        cache_token_source: 'unavailable',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'pi rpc usage with cache and provider total',
      usage: {
        input_tokens: 700,
        output_tokens: 16,
        cached_read_tokens: 140,
        cached_write_tokens: 9,
        total_tokens: 716,
      },
      expected: {
        input_tokens_provider: 700,
        input_tokens_effective: 700,
        output_tokens: 16,
        total_tokens: 716,
        cache_read_input_tokens: 140,
        cache_creation_input_tokens: 9,
        uncached_input_tokens: 560,
        cache_token_source: 'openai',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'qoder usage without cache',
      usage: {
        input_tokens: 800,
        output_tokens: 17,
      },
      expected: {
        input_tokens_provider: 800,
        input_tokens_effective: 800,
        output_tokens: 17,
        total_tokens: 817,
        cache_token_source: 'unavailable',
        token_count_source: 'provider_usage',
      },
    },
    {
      name: 'copilot result usage',
      usage: {
        input_tokens: 900,
        output_tokens: 18,
      },
      expected: {
        input_tokens_provider: 900,
        input_tokens_effective: 900,
        output_tokens: 18,
        total_tokens: 918,
        cache_token_source: 'unavailable',
        token_count_source: 'provider_usage',
      },
    },
  ])('normalizes $name for run_finished token analytics', ({ usage, expected }) => {
    const result = scanRunEventsForUsageAnalytics(
      [{ event: 'agent', data: { type: 'usage', usage } }],
      '',
      0,
    );

    expect(result).toMatchObject(expected);
  });

  it('reports unknown token source for plain mock agents without usage events', () => {
    const result = scanRunEventsForUsageAnalytics(
      [{ event: 'agent', data: { type: 'text_delta', delta: 'plain output' } }],
      '',
      0,
    );

    expect(result).toEqual({
      cache_token_source: 'unavailable',
      token_count_source: 'unknown',
      agent_reported_model: null,
    });
  });
});

describe('summarizeRunTimingAnalytics', () => {
  it('summarizes main run-path timings and aggregate tool duration', () => {
    const result = summarizeRunTimingAnalytics({
      runCreatedAt: 1_000,
      runUpdatedAt: 8_000,
      analyticsCapturedAt: 8_020,
      telemetry: {
        startRequestedAt: 1_100,
        startChatRunStartedAt: 1_200,
        processSpawnStartedAt: 1_700,
        processSpawnedAt: 1_760,
        firstTokenAt: 2_500,
      },
      events: [
        {
          id: 1,
          event: 'agent',
          timestamp: 3_000,
          data: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        {
          id: 2,
          event: 'agent',
          timestamp: 3_400,
          data: { type: 'tool_result', toolUseId: 'tool-1' },
        },
        {
          id: 3,
          event: 'agent',
          timestamp: 4_000,
          data: { type: 'tool_use', id: 'tool-2', name: 'Write' },
        },
        {
          id: 4,
          event: 'agent',
          timestamp: 4_250,
          data: { type: 'tool_result', toolUseId: 'tool-2' },
        },
      ],
    });

    expect(result).toEqual({
      queue_duration_ms: 200,
      pre_spawn_duration_ms: 500,
      process_spawn_duration_ms: 60,
      time_to_first_token_ms: 1300,
      spawn_to_first_token_ms: 740,
      generation_duration_ms: 5500,
      tool_call_count: 2,
      tool_duration_ms: 650,
      finalize_duration_ms: 20,
      total_duration_ms: 7020,
    });
  });
});
