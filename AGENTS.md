# Repository workflow

Use [T3 Code's contributor workflow](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md#pull-requests)
as a reference, adapted to this repository and the user's instructions.

## Pull requests

- Open a PR only when the user asks for one. Keep one request in one PR unless asked to split it.
- Use a plain-language conventional title, for example `fix(admin): save role settings reliably`.
- Explain the problem in one or two sentences, then how the change fixes it. Aim for under 100 words.
- Add the relevant verification and observed result. Mention material gaps; skip exhaustive checklists.
- For UI changes, attach before/after images, or a short video when interaction or timing matters.
  Upload PR evidence to GitHub; do not commit assets used only for PR review.
- End with a short model and harness attribution.

## Documentation

- Update existing guidance when behavior changes. Keep user docs focused on completing a task.
- Add internal documentation only for decisions, cross-cutting constraints, or traps that the code
  cannot explain. Do not append PR summaries, implementation narratives, or file catalogs.
- Keep release procedures specific to this repository: validated main pushes produce releases.
  T3 Code's nightly/stable cadence is a reference, not a change to that policy.
