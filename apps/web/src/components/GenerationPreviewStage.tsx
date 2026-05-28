import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { GenerationPreviewModel } from '../runtime/generation-preview';
import { formatGenerationElapsed } from '../runtime/generation-preview';
import { Icon } from './Icon';
import styles from './GenerationPreviewStage.module.css';

type Props = {
  model: GenerationPreviewModel;
  onRetry?: (() => void) | undefined;
};

export function GenerationPreviewStage({ model, onRetry }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (model.failed) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [model.failed, model.startedAt]);

  const elapsedSec = Math.max(0, Math.round((now - model.startedAt) / 1000));
  const elapsedLabel = formatGenerationElapsed(elapsedSec);

  const stepLabels: Record<GenerationPreviewModel['steps'][number]['id'], string> = {
    understand: t('generationPreview.stepUnderstand'),
    generate: t('generationPreview.stepGenerate'),
    prepare: t('generationPreview.stepPrepare'),
  };

  return (
    <section
      className={styles.stage}
      data-testid="generation-preview-stage"
      aria-live="polite"
      aria-busy={!model.failed}
    >
      <div className={styles.mark} aria-hidden>
        <Icon name="sparkles" size={24} />
      </div>
      <h1 className={styles.title}>
        {model.failed ? t('generationPreview.failedTitle') : t('generationPreview.title')}
      </h1>
      <p className={styles.lead}>
        {model.failed
          ? model.errorMessage || t('generationPreview.failedFallback')
          : t('generationPreview.footnote')}
      </p>
      <div
        className={styles.progress}
        role="progressbar"
        aria-label={t('generationPreview.progressAria', { percent: model.progressPercent })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.progressPercent}
      >
        <span style={{ width: `${model.progressPercent}%` }} />
      </div>
      <ol className={styles.steps}>
        {model.steps.map((step) => (
          <li key={step.id} className={styles.step} data-status={step.status}>
            <span className={styles.stepIcon} aria-hidden>
              {step.status === 'succeeded' ? (
                <Icon name="check" size={12} />
              ) : step.status === 'failed' ? (
                <Icon name="close" size={12} />
              ) : (
                <span className={styles.stepDot} />
              )}
            </span>
            <span className={styles.stepLabel}>{stepLabels[step.id]}</span>
          </li>
        ))}
      </ol>
      <div className={styles.meta}>
        <span data-testid="generation-preview-elapsed">
          {t('generationPreview.elapsed', { elapsed: elapsedLabel })}
        </span>
        <span className={styles.metaDivider} aria-hidden>
          ·
        </span>
        <span>{t('generationPreview.estimate')}</span>
      </div>
      {model.failed && onRetry ? (
        <button
          type="button"
          className={styles.retry}
          data-testid="generation-preview-retry"
          onClick={onRetry}
        >
          {t('generationPreview.retry')}
        </button>
      ) : null}
    </section>
  );
}
