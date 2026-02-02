# Auto PR Merger Skill

This skill automates the workflow of checking out a GitHub PR, running tests, attempting to fix failures, and merging if successful.

## Usage

```bash
node skills/auto-pr-merger/index.js --pr <PR_NUMBER_OR_URL> --test "<TEST_COMMAND>" [--retries <NUMBER>]
```

## Arguments

- `--pr`: The PR number or URL (e.g., `123` or `https://github.com/owner/repo/pull/123`).
- `--test`: The command to run tests (e.g., `npm test`, `pytest`).
- `--retries`: (Optional) Number of times to attempt fixing the code if tests fail. Default: 3.

## Requirements

- `gh` CLI installed and authenticated.
- Node.js environment.

## Logic

1.  Checks out the PR using `gh pr checkout`.
2.  Runs the specified test command.
3.  If tests fail:
    *   Reads the output.
    *   Attempts a fix (Currently a placeholder/mock fix logic).
    *   Commits and pushes the fix.
    *   Retries the test command.
4.  If tests pass:
    *   Merges the PR using `gh pr merge --merge --auto`.
