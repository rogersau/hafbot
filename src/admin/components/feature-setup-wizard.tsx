import { useState, type ReactNode } from "react";

import { SectionHeader } from "./admin-form-layout";
import { Button } from "./ui/button";

export interface FeatureSetupWizardStep {
  id: string;
  label: string;
  purpose: ReactNode;
  outcome: ReactNode;
  changes: ReactNode;
  content: ReactNode;
  canContinue?: boolean;
  continueHint?: ReactNode;
}

interface FeatureSetupWizardProps {
  title: string;
  description?: ReactNode;
  steps: readonly FeatureSetupWizardStep[];
  defaultStep?: number | string;
}

export function FeatureSetupWizard({
  title,
  description,
  steps,
  defaultStep = 0,
}: FeatureSetupWizardProps) {
  const lastStep = Math.max(0, steps.length - 1);
  const [step, setStep] = useState(() => {
    const requestedStep =
      typeof defaultStep === "string"
        ? steps.findIndex((candidate) => candidate.id === defaultStep)
        : defaultStep;
    return Math.min(Math.max(0, requestedStep), lastStep);
  });
  const currentStep = steps[Math.min(step, lastStep)];

  if (!currentStep) return null;

  function moveTo(nextStep: number) {
    const boundedStep = Math.min(Math.max(0, nextStep), lastStep);
    setStep(boundedStep);
  }

  const titleId = `feature-setup-${currentStep.id}-label`;
  const panelId = `feature-setup-${currentStep.id}-panel`;

  return (
    <section className="admin-feature-setup-wizard space-y-5" aria-label={title}>
      <SectionHeader title={title} description={description} />

      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Your setup journey</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Work through these steps in order. You can return to earlier steps before finishing.
          </p>
        </div>
        <ol
          className="admin-feature-setup-progress grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3"
          aria-label={`${title} progress`}
        >
          {steps.map((candidate, index) => (
            <li
              key={candidate.id}
              className={
                index === step
                  ? "rounded-md border border-accent/50 bg-accent/10 p-3"
                  : "rounded-md border bg-background/70 p-3"
              }
            >
              <span
                id={`feature-setup-${candidate.id}-label`}
                aria-current={index === step ? "step" : undefined}
                className={
                  index === step
                    ? "rounded-full bg-accent px-2 py-0.5 font-medium text-accent-foreground"
                    : index < step
                      ? "rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent"
                      : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                }
              >
                {index + 1}. {candidate.label}
              </span>
              {candidate.purpose ? (
                <p className="mt-2 leading-5 text-muted-foreground">{candidate.purpose}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      {currentStep.purpose || currentStep.changes || currentStep.outcome ? (
        <aside className="grid gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4 md:grid-cols-3">
          {currentStep.purpose ? (
            <div>
              <strong className="text-xs font-semibold uppercase tracking-wide text-accent">
                Why this step
              </strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{currentStep.purpose}</p>
            </div>
          ) : null}
          {currentStep.changes ? (
            <div>
              <strong className="text-xs font-semibold uppercase tracking-wide text-accent">
                What this changes
              </strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{currentStep.changes}</p>
            </div>
          ) : null}
          {currentStep.outcome ? (
            <div>
              <strong className="text-xs font-semibold uppercase tracking-wide text-accent">
                What success looks like
              </strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{currentStep.outcome}</p>
            </div>
          ) : null}
        </aside>
      ) : null}

      <div id={panelId} role="group" aria-labelledby={titleId}>
        {currentStep.content}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={step === 0}
          onClick={() => moveTo(step - 1)}
        >
          Back
        </Button>
        <div className="text-center text-xs text-muted-foreground">
          <span>
            Step {step + 1} of {steps.length}
          </span>
          {currentStep.canContinue === false && currentStep.continueHint ? (
            <p className="mt-1" role="status">
              {currentStep.continueHint}
            </p>
          ) : null}
        </div>
        {step < lastStep ? (
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={currentStep.canContinue === false}
            onClick={() => moveTo(step + 1)}
          >
            Continue
          </Button>
        ) : (
          <span className="w-16" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}
