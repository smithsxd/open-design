import type { AgentEvent, ChatMessage, LiveArtifactSummary, ProjectFile } from '../types';
import { isLiveArtifactTabId } from '../types';

export type GenerationStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface GenerationPreviewStep {
  id: 'understand' | 'generate' | 'prepare';
  status: GenerationStepStatus;
}

export interface GenerationPreviewModel {
  startedAt: number;
  steps: GenerationPreviewStep[];
  failed: boolean;
  errorMessage: string | null;
  progressPercent: number;
}

const PREVIEWABLE_FILE = /\.(html?|jsx|tsx|svg|md|pdf|pptx?|key)$/i;

export function workspaceHasPreviewSurface(input: {
  activeTab: string | null;
  projectFiles: ProjectFile[];
  liveArtifacts: LiveArtifactSummary[];
  streamingArtifactHtml?: string | null | undefined;
}): boolean {
  if (input.streamingArtifactHtml?.trim()) return true;
  const active = input.activeTab;
  if (!active) return false;
  if (isLiveArtifactTabId(active)) {
    return input.liveArtifacts.some((entry) => entry.tabId === active);
  }
  const file = input.projectFiles.find((item) => item.name === active);
  if (!file) return false;
  if (file.kind === 'image' || file.kind === 'video' || file.kind === 'audio' || file.kind === 'sketch') {
    return true;
  }
  if (PREVIEWABLE_FILE.test(file.name)) return true;
  return file.kind === 'html' || file.kind === 'code' || file.kind === 'text';
}

export function deriveGenerationPreviewModel(input: {
  events: AgentEvent[];
  hasArtifactHtml: boolean;
  hasPreviewSurface: boolean;
  failed: boolean;
  errorMessage?: string | null;
}): Pick<GenerationPreviewModel, 'steps' | 'progressPercent' | 'errorMessage'> {
  const steps = derivePrototypeGenerationSteps({
    events: input.events,
    hasArtifactHtml: input.hasArtifactHtml,
    hasPreviewSurface: input.hasPreviewSurface,
    failed: input.failed,
  });
  const progressPercent = generationPreviewProgress(steps);
  return {
    steps,
    progressPercent,
    errorMessage: input.failed ? input.errorMessage?.trim() || failureMessageFromEvents(input.events) : null,
  };
}

export function buildGenerationPreviewState(input: {
  designSystemProject: boolean;
  messages: ChatMessage[];
  streaming: boolean;
  activeTab: string | null;
  projectFiles: ProjectFile[];
  liveArtifacts: LiveArtifactSummary[];
  artifactHtml?: string | null;
  conversationError?: string | null;
}): (GenerationPreviewModel & { retryTarget: ChatMessage | null }) | null {
  if (input.designSystemProject) return null;

  const hasPreviewSurface = workspaceHasPreviewSurface({
    activeTab: input.activeTab,
    projectFiles: input.projectFiles,
    liveArtifacts: input.liveArtifacts,
    streamingArtifactHtml: input.artifactHtml,
  });

  const latestAssistant = [...input.messages]
    .reverse()
    .find((message) => message.role === 'assistant');

  if (!latestAssistant) return null;

  const runActive = isActiveRunStatus(latestAssistant.runStatus) || input.streaming;
  const runFailed = latestAssistant.runStatus === 'failed';
  if (!runActive && !runFailed) return null;
  if (hasPreviewSurface && !runFailed) return null;

  const events = latestAssistant.events ?? [];
  const derived = deriveGenerationPreviewModel({
    events,
    hasArtifactHtml: Boolean(input.artifactHtml?.trim()),
    hasPreviewSurface,
    failed: runFailed,
    errorMessage: input.conversationError,
  });

  const startedAt = latestAssistant.startedAt ?? latestAssistant.createdAt ?? Date.now();

  return {
    startedAt,
    steps: derived.steps,
    failed: runFailed,
    errorMessage: derived.errorMessage,
    progressPercent: derived.progressPercent,
    retryTarget: runFailed ? latestAssistant : null,
  };
}

export function derivePrototypeGenerationSteps(input: {
  events: AgentEvent[];
  hasArtifactHtml: boolean;
  hasPreviewSurface: boolean;
  failed: boolean;
}): GenerationPreviewStep[] {
  const hasStatus = (labels: string[]) =>
    eventsHaveStatus(input.events, labels);
  const hasToolUse = input.events.some((event) => event.kind === 'tool_use');
  const hasWriteLikeTool = input.events.some(
    (event) =>
      event.kind === 'tool_use'
      && typeof event.name === 'string'
      && /^(write|edit|bash|run_terminal_cmd)$/i.test(event.name),
  );
  const hasArtifactStart = input.events.some(
    (event) => event.kind === 'text' && event.text.includes('<artifact'),
  ) || input.hasArtifactHtml;
  const hasText = input.events.some((event) => event.kind === 'text' && event.text.trim().length > 0);

  let understand: GenerationStepStatus = 'running';
  if (input.failed && !hasText && !hasToolUse) {
    understand = 'failed';
  } else if (hasText || hasStatus(['thinking', 'streaming', 'requesting', 'starting']) || hasToolUse) {
    understand = 'succeeded';
  }

  let generate: GenerationStepStatus = 'pending';
  if (understand === 'succeeded') {
    generate = 'running';
  }
  if (hasWriteLikeTool || hasArtifactStart) {
    generate = 'succeeded';
  }
  if (input.failed && understand === 'succeeded' && !hasWriteLikeTool && !hasArtifactStart) {
    generate = 'failed';
  }

  let prepare: GenerationStepStatus = 'pending';
  if (generate === 'succeeded') {
    prepare = 'running';
  }
  if (input.hasPreviewSurface || input.hasArtifactHtml) {
    prepare = 'succeeded';
  }
  if (input.failed && generate === 'succeeded' && !input.hasPreviewSurface && !input.hasArtifactHtml) {
    prepare = 'failed';
  }

  return [
    { id: 'understand', status: understand },
    { id: 'generate', status: generate },
    { id: 'prepare', status: prepare },
  ];
}

export function generationPreviewProgress(steps: GenerationPreviewStep[]): number {
  if (steps.length === 0) return 8;
  const weights = { pending: 0, running: 0.45, succeeded: 1, failed: 0.2 };
  const score = steps.reduce((sum, step) => sum + weights[step.status], 0) / steps.length;
  return Math.max(8, Math.min(steps.some((step) => step.status === 'failed') ? 72 : 92, Math.round(score * 100)));
}

export function formatGenerationElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

function eventsHaveStatus(events: AgentEvent[], labels: string[]): boolean {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  return events.some(
    (event) =>
      event.kind === 'status'
      && normalized.has(event.label.toLowerCase()),
  );
}

function failureMessageFromEvents(events: AgentEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'text' && event.text.trim()) return event.text.trim();
    if (event.kind === 'status' && event.detail?.trim()) return event.detail.trim();
  }
  return null;
}
