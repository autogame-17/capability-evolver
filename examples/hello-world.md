# Hello World — Quick Start

Try Evolver locally in 3 steps:

1. Clone & enter:

```bash
git clone https://github.com/EvoMap/evolver.git && cd evolver
```

2. Install and run a single evolution:

```bash
npm ci
node index.js
```

3. Review mode (human-in-the-loop):

```bash
npm run review
```

Expected: the tool prints a GEP prompt to stdout. Use `--loop` to run continuously.

Docker quickstart:

```bash
# build
docker build -t evolver:demo .
# run a single evolution
docker run --rm evolver:demo node index.js
```

