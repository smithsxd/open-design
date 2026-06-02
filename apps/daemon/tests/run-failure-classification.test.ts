import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/integrations/vela-errors.js', () => ({
  classifyAmrAccountFailure(text: string) {
    const value = String(text || '').toLowerCase();
    if (value.includes('insufficient balance')) {
      return { code: 'AMR_INSUFFICIENT_BALANCE' as const };
    }
    if (value.includes('authentication required') || value.includes('not authenticated') || value.includes('unauthorized')) {
      return { code: 'AMR_AUTH_REQUIRED' as const };
    }
    return null;
  },
}));

vi.mock('../src/runtimes/auth.js', () => ({
  classifyAgentServiceFailure(text: string) {
    const value = String(text || '').toLowerCase();
    if (value.includes('authentication required') || value.includes('not authenticated')) {
      return 'AGENT_AUTH_REQUIRED' as const;
    }
    if (value.includes('http 429') || value.includes('too many requests') || value.includes('session limit')) {
      return 'RATE_LIMITED' as const;
    }
    if (value.includes('503 upstream unavailable') || value.includes('upstream unavailable')) {
      return 'UPSTREAM_UNAVAILABLE' as const;
    }
    return null;
  },
}));

import {
  classifyRunFailure,
  type RunEventForFailureClassification,
} from '../src/run-failure-classification.js';

function errorEvent(
  code: string,
  message: string,
  retryable?: boolean,
): RunEventForFailureClassification {
  return {
    event: 'error',
    data: {
      message,
      error: {
        code,
        message,
        ...(retryable !== undefined ? { retryable } : {}),
      },
    },
  };
}

function classify(
  code: string | null,
  message = '',
  events: RunEventForFailureClassification[] = code
    ? [errorEvent(code, message)]
    : [],
) {
  return classifyRunFailure({
    result: 'failed',
    status: {
      status: 'failed',
      error: message || null,
      errorCode: code,
      exitCode: 1,
      signal: null,
    },
    ...(code ? { errorCode: code } : {}),
    agentId: 'claude',
    events,
  });
}

describe('classifyRunFailure', () => {
  it('does not classify successful runs as failures', () => {
    expect(
      classifyRunFailure({
        result: 'success',
        status: { status: 'succeeded' },
      }),
    ).toBeUndefined();
  });

  it('classifies user cancellation separately from failures', () => {
    expect(
      classifyRunFailure({
        result: 'cancelled',
        status: { status: 'canceled' },
      }),
    ).toEqual({
      failure_category: 'user_cancel',
      failure_stage: 'finalize',
      retryable: false,
      user_action: 'none',
    });
  });


  it('prefers user cancellation over timeout-flavored status text when the run result is cancelled', () => {
    expect(
      classifyRunFailure({
        result: 'cancelled',
        status: {
          status: 'canceled',
          error: 'Agent stalled without emitting any new output for 120s.',
          signal: 'SIGTERM',
          exitCode: null,
          errorCode: 'AGENT_SIGNAL_SIGTERM',
        },
        errorCode: 'AGENT_SIGNAL_SIGTERM',
        events: [
          errorEvent(
            'AGENT_SIGNAL_SIGTERM',
            'Agent stalled without emitting any new output for 120s.',
            true,
          ),
        ],
      }),
    ).toEqual({
      failure_category: 'user_cancel',
      failure_stage: 'finalize',
      retryable: false,
      user_action: 'none',
    });
  });

  it('prefers structured model-unavailable codes over timeout-like free text', () => {
    expect(
      classify(
        'AMR_MODEL_UNAVAILABLE',
        'Model selection timed out while the provider reported the model was unavailable.',
      ),
    ).toMatchObject({
      failure_category: 'model_unavailable',
      failure_stage: 'model_select',
      retryable: false,
      user_action: 'switch_model',
    });
  });

  it('prefers prompt-too-large codes over empty-output fallback text', () => {
    expect(
      classify(
        'AGENT_PROMPT_TOO_LARGE',
        'The agent completed without producing any output because the context window exceeded the limit.',
      ),
    ).toMatchObject({
      failure_category: 'prompt_too_large',
      failure_stage: 'prompt_send',
      retryable: false,
      user_action: 'reduce_context',
    });
  });

  it('maps auth-required failures to login guidance', () => {
    expect(classify('AGENT_AUTH_REQUIRED')).toMatchObject({
      failure_category: 'auth',
      failure_stage: 'session_init',
      retryable: false,
      user_action: 'login',
    });
  });


  it('lets explicit auth classification win over a generic execution-failed code', () => {
    expect(
      classify(
        'AGENT_EXECUTION_FAILED',
        'Authentication required before starting the session.',
      ),
    ).toMatchObject({
      failure_category: 'auth',
      failure_stage: 'session_init',
      retryable: false,
      user_action: 'login',
    });
  });

  it('recognizes model-not-found text even when the outer error code is generic', () => {
    expect(
      classify('AGENT_EXECUTION_FAILED', 'Model not found: vela/deepseek-v3-2'),
    ).toMatchObject({
      failure_category: 'model_unavailable',
      failure_stage: 'model_select',
      retryable: false,
      user_action: 'switch_model',
    });
  });

  it('recovers rate-limit and session-limit signals from generic error codes', () => {
    expect(
      classify(
        'AGENT_EXECUTION_FAILED',
        "You've hit your session limit; resets at 3:10am.",
      ),
    ).toMatchObject({
      failure_category: 'rate_limit',
      retryable: false,
      user_action: 'none',
    });
  });

  it('treats ordinary 429 rate limits as retryable', () => {
    expect(classify('RATE_LIMITED', 'HTTP 429: too many requests')).toMatchObject({
      failure_category: 'rate_limit',
      retryable: true,
      user_action: 'retry',
    });
  });

  it('maps upstream failures to retry guidance', () => {
    expect(classify('UPSTREAM_UNAVAILABLE', 'HTTP 503 upstream unavailable')).toMatchObject({
      failure_category: 'upstream_unavailable',
      failure_stage: 'first_token_wait',
      retryable: true,
      user_action: 'retry',
    });
  });

  it('maps AMR insufficient balance to recharge guidance', () => {
    expect(
      classify('AMR_INSUFFICIENT_BALANCE', 'insufficient wallet balance'),
    ).toMatchObject({
      failure_category: 'insufficient_balance',
      retryable: false,
      user_action: 'recharge',
    });
  });

  it('maps unavailable model errors to switch-model guidance', () => {
    expect(classify('AMR_MODEL_UNAVAILABLE', 'model is not available')).toMatchObject({
      failure_category: 'model_unavailable',
      failure_stage: 'model_select',
      retryable: false,
      user_action: 'switch_model',
    });
  });

  it('maps prompt-size failures to reduce-context guidance', () => {
    expect(classify('AGENT_PROMPT_TOO_LARGE', 'context window exceeded')).toMatchObject({
      failure_category: 'prompt_too_large',
      failure_stage: 'prompt_send',
      retryable: false,
      user_action: 'reduce_context',
    });
  });

  it('maps empty output to an explicit retryable category', () => {
    expect(
      classify(
        'AGENT_EXECUTION_FAILED',
        'Agent completed without producing any output.',
        [errorEvent('AGENT_EXECUTION_FAILED', 'Agent completed without producing any output.', true)],
      ),
    ).toMatchObject({
      failure_category: 'empty_output',
      retryable: true,
      user_action: 'retry',
    });
  });

  it('maps signal exits and stall text to timeout', () => {
    expect(
      classifyRunFailure({
        result: 'failed',
        status: {
          status: 'failed',
          error: 'Agent stalled without emitting any new output for 120s.',
          signal: 'SIGTERM',
          exitCode: null,
          errorCode: null,
        },
        errorCode: 'AGENT_SIGNAL_SIGTERM',
        events: [],
      }),
    ).toMatchObject({
      failure_category: 'timeout',
      failure_stage: 'first_token_wait',
      retryable: true,
      user_action: 'retry',
    });
  });


  it('honors the latest explicit non-retryable hint for timeout failures', () => {
    expect(
      classifyRunFailure({
        result: 'failed',
        status: {
          status: 'failed',
          error: 'Agent stalled without emitting any new output for 120s.',
          signal: 'SIGTERM',
          exitCode: null,
          errorCode: null,
        },
        errorCode: 'AGENT_SIGNAL_SIGTERM',
        agentId: 'claude',
        events: [
          errorEvent('AGENT_EXECUTION_FAILED', 'transient upstream hiccup', true),
          errorEvent(
            'AGENT_SIGNAL_SIGTERM',
            'Agent stalled without emitting any new output for 120s.',
            false,
          ),
        ],
      }),
    ).toMatchObject({
      failure_category: 'timeout',
      failure_stage: 'first_token_wait',
      retryable: false,
      user_action: 'none',
    });
  });

  it('uses the latest retryable hint for tool execution failures', () => {
    expect(
      classifyRunFailure({
        result: 'failed',
        status: {
          status: 'failed',
          error: 'Tool error: MCP connector failed while listing files.',
          exitCode: 1,
          signal: null,
          errorCode: 'AGENT_EXECUTION_FAILED',
        },
        errorCode: 'AGENT_EXECUTION_FAILED',
        agentId: 'claude',
        events: [
          errorEvent('AGENT_EXECUTION_FAILED', 'tool bootstrap failed', false),
          errorEvent(
            'AGENT_EXECUTION_FAILED',
            'Tool error: MCP connector failed while listing files.',
            true,
          ),
        ],
      }),
    ).toMatchObject({
      failure_category: 'tool_error',
      failure_stage: 'tool_execution',
      retryable: true,
      user_action: 'retry',
    });
  });

  it('keeps process exits as an explicit fallback category', () => {
    expect(classify('AGENT_EXIT_1', 'process exited with code 1')).toMatchObject({
      failure_category: 'process_exit',
      failure_stage: 'child_close',
      retryable: false,
      user_action: 'none',
    });
  });

  it('falls back to unknown when no meaningful signal is available', () => {
    expect(classify('SOMETHING_NEW', '')).toMatchObject({
      failure_category: 'unknown',
      failure_stage: 'finalize',
      retryable: false,
      user_action: 'none',
    });
  });
});
