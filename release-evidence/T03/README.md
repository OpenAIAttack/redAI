# T03 — Contract type generation & validation — evidence

All commands run from repo root unless noted. Results:

| Check | Command | Result |
|-------|---------|--------|
| Codegen (write) | `pnpm --filter @redai/contracts run codegen` | 3 files written (01-codegen.txt) |
| Drift guard | `pnpm --filter @redai/contracts run codegen:check` | OK, not stale (02-codegen-check.txt) |
| Package build | `pnpm --filter @redai/contracts run build` | tsc -b exit 0 (03-build.txt) |
| TS contract suite | `pnpm exec vitest run tests/contracts` | 43 passed (04-vitest.txt) |
| Go parity + race | `cd worker && go vet ./internal/contracts/... && go test -race ./internal/contracts/...` | PASS, no go.sum (05-go-test.txt) |
| Codegen idempotent | run codegen twice | identical output |
| Prettier | `prettier --check packages/contracts tests/contracts` | clean |
| ESLint (scoped) | `eslint packages/contracts/src tests/contracts` | 0 problems |

Parity is on shared inputs: both the TS (Ajv) suite and the Go test read the
same `contracts/examples/*.json` fixtures and the same
`tests/contracts/contract-cases.json` manifest (29 fixtures).
