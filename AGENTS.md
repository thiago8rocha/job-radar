# job-radar — agent instructions

## Language
- Write everything in English: code, comments, commit messages, PR titles and descriptions,
  docs, README, examples, issue templates, labels and any text the tool generates.

## Commits
- Follow Conventional Commits 1.0: `<type>(<scope>): <summary>`.
- Types: feat, fix, docs, test, refactor, perf, build, ci, chore.
- Scopes: a source adapter (inhire, greenhouse, himalayas...), pipeline, github, metrics, config, action.
- Summary in imperative mood, lowercase, no trailing period, max 72 characters.
- Breaking changes: `!` after the type and a `BREAKING CHANGE:` footer.
- One logical change per commit.

## Project
- Design lives in docs/DESIGN.md. Build one phase at a time; do not start the next phase unless asked.
- Stack: Node 20+, TypeScript, zod, Vitest, msw, Octokit.
- Every adapter validates responses with a zod schema and has contract tests with recorded fixtures.
- Never commit personal data, tokens or a real config; examples live in examples/.
- License: MIT.
