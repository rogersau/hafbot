import { useState } from "react";
import { FIRST_WORKFLOWS, withFirstWorkflow, type FirstWorkflow } from "../first-workflows";

export function FirstWorkflowSelector() {
  const [selected, setSelected] = useState<FirstWorkflow>();

  return (
    <section
      id="first-workflow"
      tabIndex={-1}
      className="landing-shell py-8"
      aria-labelledby="first-workflow-title"
    >
      <header className="mb-4">
        <h2 id="first-workflow-title" className="text-2xl font-semibold">
          What do you want to fix first?
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Pick one job and try it with a member before adding anything else.
        </p>
      </header>
      <fieldset>
        <legend className="sr-only">Choose a starting workflow</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {FIRST_WORKFLOWS.map((workflow) => (
            <label
              key={workflow.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm has-checked:border-[var(--accent)]"
            >
              <input
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                type="radio"
                name="first-workflow"
                value={workflow.id}
                checked={selected?.id === workflow.id}
                onChange={() => setSelected(workflow)}
              />
              {workflow.label}
            </label>
          ))}
        </div>
      </fieldset>
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
