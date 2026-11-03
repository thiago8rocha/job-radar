# Golden cases for the fit score

`cases.json` holds real postings (trimmed) from the author's job search, each with the range of scores the author's own decision allows:
a job applied to should score 3 to 5, a job dropped for a hard reason (language, location, hybrid, on-site, pay, a suspicious posting)
1 to 2, and one dropped for stack or level 1 to 3. The point is to catch a model or provider change that makes the score drift.

- **Replay (free, runs in CI).** `test/golden.test.ts` replays `replies.json`, the raw replies a model gave earlier, through the same
  parsing as the collector and checks that at least 70% of the scores land inside their range. With no `replies.json` it only checks the cases.
- **Live (costs API calls).** `npm run eval:golden -- --profile <file> --record` scores every case with the provider in `AI_BASE_URL`,
  `AI_MODEL` and `AI_API_KEY`, prints the agreement, exits with an error below the minimum and, with `--record`, saves the replies for the replay.
  The workflow `eval-golden` does the same on demand.

The profile is read from a file you pass and is never written anywhere: only the model's replies are recorded.
