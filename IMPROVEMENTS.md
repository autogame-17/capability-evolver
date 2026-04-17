Improvements suggested by @sharkello

Summary
-------
Small, high‑impact changes to increase discoverability and first‑time user success.

Top items
---------
- Add a concise TL;DR (3 lines) at the top of README with a one-line 'Try it' command.
- Provide a single‑command quickstart: `npm install && node index.js` or a docker example.
- Add an `examples/` folder with 3 minimal use cases and copy‑paste commands.
- Create 5 `good first issue` tickets (docs, CI badge, docker quickstart, small test, README shortening).
- Add CONTRIBUTING.md, CODE_OF_CONDUCT.md (short), and ISSUE templates.
- Add a short demo GIF (top of README) showing a run and one output snippet.

Suggested README TL;DR (copy/paste)
----------------------------------
```markdown
# Evolver — GEP self‑evolution engine
A lightweight engine that emits protocol‑bound GEP prompts for reproducible agent evolution.
Try it in 1 command: `npm install && node index.js` (works offline).
```

Quick 'Try it' Docker example
----------------------------
```bash
# build
docker build -t evomer:demo .
# run a single evolution
docker run --rm evomer:demo node index.js
```

Good first issues to add
-----------------------
- "Add Docker quickstart (Dockerfile + run example)" — label: `good first issue`, `docs`.
- "Create CONTRIBUTING.md" — label: `good first issue`, `docs`.
- "Add examples/hello-world.md with copy/paste run" — label: `good first issue`, `examples`.
- "Add CI badge to README (GitHub Actions)" — label: `good first issue`, `ci`.
- "Add unit test for selector logic" — label: `good first issue`, `test`.

Notes
-----
I prepared a branch with this file and a commit. I can open PRs/forks if you allow pushing to GitHub (I have SSH keys configured).
