export const statuses = ["pass", "fail", "blocked", "not-run"];

export function summarize(cases) {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const item of cases) {
    if (!statuses.includes(item.status)) throw new Error(`Invalid QA status: ${item.status}`);
    counts[item.status] += 1;
  }
  return counts;
}

export function exitCode(cases) {
  const counts = summarize(cases);
  if (counts.fail) return 1;
  if (counts.blocked || !counts.pass) return 2;
  return 0;
}

export function selectScenarios(scenarios, requested) {
  if (!requested) return scenarios;
  const names = requested.split(",");
  for (const name of names) {
    if (!scenarios.some((scenario) => scenario.id === name)) {
      throw new Error(`Unknown Admin QA scenario: ${name}`);
    }
  }
  return scenarios.filter((scenario) => names.includes(scenario.id));
}
