import { useState } from "react";
import {
  findFirstWorkflow,
  FIRST_WORKFLOWS,
  withFirstWorkflow,
  type FirstWorkflow,
} from "../first-workflows";

export function FirstWorkflowSelector() {
  const [selected, setSelected] = useState<FirstWorkflow>();

  return (
    <section
      id="first-workflow"
      tabIndex={-1}
      className="mt-5"
      aria-labelledby="first-workflow-label"
    >
      <div className="flex flex-wrap items-center gap-3">
        <label id="first-workflow-label" htmlFor="workflow-choice" className="font-semibold">
          Set up your first workflow
        </label>
        <select
          id="workflow-choice"
          className="min-h-11 max-w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
          value={selected?.id ?? ""}
          onChange={(event) => setSelected(findFirstWorkflow(event.target.value))}
        >
          <option value="">Choose a workflow</option>
          {FIRST_WORKFLOWS.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.label}
            </option>
          ))}
        </select>
      </div>
      <p className="sr-only" role="status">
        {selected ? `${selected.feature} setup details available below.` : ""}
      </p>
      {selected ? (
        <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <h3 className="text-lg font-semibold">{selected.feature}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{selected.outcome}</p>
          <ul className="my-3 list-disc space-y-1 pl-5 text-sm">
            {selected.requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
          <p className="text-sm">
            <strong>Set up one feature.</strong> {selected.completion}
          </p>
          <p className="mt-2 text-sm">
            <strong>Test as a member.</strong> {selected.memberTest}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a className="button button-primary" href={withFirstWorkflow("/install", selected.id)}>
              Review install permissions
            </a>
            <a className="button button-ghost" href={withFirstWorkflow("/admin", selected.id)}>
              Already installed? Open dashboard setup
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
