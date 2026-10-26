# OpenHands GitHub delivery

Develop on a unique `codex/` branch, commit changes, run GitHub Actions and open a PR against `main`. Codex checks the exact current head SHA and its complete CI results, then separately approves and merges that SHA. Failed, missing, pending or skipped CI cannot count as success; a new commit invalidates approval.

Run the merge-gate tests with `node --test .openhands/github-gate.test.mjs`. This initial workflow tests the merge gate and project configuration; actual application changes must also add and pass their own relevant tests. No provider credentials are stored in this repository.
