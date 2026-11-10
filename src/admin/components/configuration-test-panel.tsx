import type { ReactNode } from "react";

import { FormField, SectionHeader } from "./admin-form-layout";
import { Button } from "./ui/button";

export function ConfigurationTestPanel({
  sampleLabel,
  sample,
  onSampleChange,
  onTest,
  placeholder,
  description,
  result,
  multiline = true,
  controls,
}: {
  sampleLabel: string;
  sample: string;
  onSampleChange: (sample: string) => void;
  onTest: () => void;
  placeholder?: string;
  description: string;
  result: ReactNode;
  multiline?: boolean;
  controls?: ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-[4px] border border-dashed bg-muted/20 p-4">
      <SectionHeader title="Test configuration" description={description} />
      {controls}
      <FormField label={sampleLabel} htmlFor="configuration-test-sample">
        {multiline ? (
          <textarea
            id="configuration-test-sample"
            className="min-h-28 w-full rounded-[3px] border bg-background/70 px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={sample}
            placeholder={placeholder}
            onChange={(event) => onSampleChange(event.target.value)}
          />
        ) : (
          <input
            id="configuration-test-sample"
            className="flex h-9 w-full rounded-[3px] border border-input bg-background/70 px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={sample}
            placeholder={placeholder}
            onChange={(event) => onSampleChange(event.target.value)}
          />
        )}
      </FormField>
      <Button type="button" size="sm" variant="outline" onClick={onTest}>
        Run test
      </Button>
      <div aria-live="polite">{result}</div>
    </div>
  );
}
