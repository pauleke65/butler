# Butler infrastructure (AWS CDK v2, TypeScript)

`cdk deploy` stands the whole backend up in `us-east-1` (decision D3), one stack per stage (`butler-dev`, `butler-demo`).
Nothing in this folder has been deployed yet: see **[UNVERIFIED until first deploy](#unverified-until-first-deploy)**.

```
 simulator / Alexa+ ──Bearer sim-client token──▶ MCP server runtime  (AgentCore Runtime, MCP protocol, Cognito JWT)
                                                   │ SigV4 InvokeAgentRuntime            │ lambda:InvokeFunction
                                                   ▼                                     ▼
                                       agent runtime (HTTP, IAM)             approval-executor Lambda
                                                   │ Bearer butler-agent token           │ Bearer approval-executor token
                                                   └──────────────┬──────────────────────┘
                                                                  ▼
                              AgentCore Gateway (custom JWT) ── Cedar policy engine, ENFORCE ──▶ actions Lambda
                              5 targets: Messages Calendar Supplies Services Context           (one function, 12 tools)
                                                                                         DynamoDB · SES · Google · payments
```

| Piece | What | Where |
|---|---|---|
| Table | `butler-{stage}`: PK/SK, GSI1 (ALL), TTL `ttl`, PITR, on-demand, stream NEW_IMAGE, `DESTROY` | `lib/constructs/data.ts` |
| Cognito | pool, resource server (`butler/invoke`), domain, 3 client-credentials clients (`sim-client`, `butler-agent`, `approval-executor`) | `lib/constructs/auth.ts` |
| Secrets | `butler/{stage}/{agent-client,executor-client,sim-client}` (client secrets), placeholders `google-refresh-token`, `payment-key`, generated `debug-api-token` | `auth.ts`, `butler-stack.ts` |
| Lambdas (Python 3.12, **arm64**) | `butler-{stage}-actions`, `-approval-executor`, `-debug-api` (Function URL) | `lib/constructs/lambdas.ts` |
| AgentCore | Gateway + 5 inline-schema Lambda targets, policy engine (ENFORCE), 6 Cedar policies, 2 runtimes | `lib/constructs/agentcore.ts`, `runtimes.ts` |
| Ops | SES identities, $50/$100 budget alarms, 14-day log groups, 3 saved Logs Insights queries, SSM `/butler/{stage}/*`, outputs | `lib/constructs/ops.ts`, `butler-stack.ts` |

Application-side additions made for this: `actions/butler_action_handlers/lambda_handler.py` and
`executor/butler_executor/lambda_handler.py` (thin Lambda entries, with tests) and `agent/Dockerfile` (container fallback only).
No other application code was touched.

## Prerequisites

Node 20+ and pnpm 9+, Python 3.12 and **uv**, AWS CLI v2 (only for deploying). **Docker is not needed** for the default
(S3 code-zip) deployment. Network access to PyPI/npm for the builds.

```bash
pnpm install            # repo root: installs infra/ with the rest of the workspace
uv sync --python 3.12
```

## Everything you can do offline (no AWS credentials, no cost)

```bash
cd infra
pnpm typecheck                              # tsc
pnpm test                                   # 60 vitest tests: synth + assertions (uses stub assets, needs no build)
pnpm test:python                            # Lambda entries, agent shim, seed linker (uv run pytest ...)
pnpm build:lambdas                          # -> infra/dist/{actions,executor,debug-api}        (uv; no Docker)
pnpm build:runtimes                         # -> infra/dist/{agent-runtime,server-runtime}      (uv + esbuild; no Docker)
npx cdk synth -c account=000000000000 -c budgetEmail=you@example.org -c SES_FROM_ADDRESS=you@example.org
```

Always pass `-c account=...` for an offline synth: without it the CDK CLI resolves your default account from AWS
credentials. `cdk synth` fails with a readable message if `infra/dist` has not been built:

```
Build asset "actions" not found at .../infra/dist/actions.
Build it first:  bash infra/scripts/build-lambdas.sh
```

### Build outputs

| Script | Output | How |
|---|---|---|
| `scripts/build-lambdas.sh` | `dist/actions` (12 MB), `dist/executor` (26 MB, has cedarpy), `dist/debug-api` (10 MB) | `uv pip install --target ... --python-platform aarch64-manylinux2014 --python-version 3.12 --only-binary :all:` for third-party wheels (boto3 is NOT bundled: the Lambda runtime has it); the workspace packages and `seed/*.json` are copied as source. A unit test proves the actions entry never imports `butler_rules`/`cedarpy`. |
| `scripts/build-runtimes.sh` | `dist/agent-runtime` (58 MB: arm64 deps incl. boto3, packages, `prompts/`, `agent_entry.py`), `dist/server-runtime` (3.8 MB: esbuild ESM bundle + the six built MCP Apps views) | same `uv` approach for the agent; `pnpm --filter ./server/ui build` + esbuild for the server. The bundle was started locally with `node entry.mjs` and served `/healthz` and a view. |

### Policies

The Cedar for the base permit and the five default rules is compiled by the **real** rule compiler:
`pnpm gen:policies` (runs `scripts/gen-policies.py`) writes `generated/policies.json` (`{rule_id: cedar}`, with the
`{{AGENT_SUB}}` / `{{EXECUTOR_SUB}}` placeholders that the golden files use). CDK reads that file and replaces the placeholders
with the Cognito client-id tokens. `test/policies.test.ts` re-runs the script and fails if the committed file differs, so it
cannot drift from `libs/butler_rules`; it also compares the output to `policies/golden/*.cedar`.

## Configuration (CDK context)

`cdk deploy -c stage=dev -c key=value ...` (or put keys in `cdk.json`). Everything has a default.

| Key | Default | Meaning |
|---|---|---|
| `stage` | `dev` | `dev` or `demo`; prefixes every name with `butler-{stage}` |
| `account` | `$CDK_DEFAULT_ACCOUNT` | 12-digit account id (required; use `000000000000` for offline synth) |
| `SES_FROM_ADDRESS` | `butler-demo@example.com` | **set this**: sender identity; SES emails a verification link to it |
| `sesRecipients` | none | comma list of extra SES identities (SES sandbox: each recipient must be verified); also the actions Lambda's `SES_ALLOWED_RECIPIENTS` |
| `budgetEmail` | none | where the $50/$100 alarms go; budgets are skipped with a warning if unset |
| `adapters` | `real` | `real` = SES + Google + payment test mode; `fake` = deterministic offline adapters (use until the secrets are filled in) |
| `paymentProvider` | `stripe` | `stripe` or `paystack` (decision D12) |
| `googleCalendarId` | `primary` | |
| `llmMode` | `bedrock` | `bedrock` or `offline` (agent and server) |
| `bedrockModelPlanner` / `bedrockModelFast` | `us.anthropic.claude-sonnet-5-5` / `us.anthropic.claude-haiku-4-5-20251001-v1:0` | inference profile ids; IAM is scoped to exactly these |
| `policySettleMs` | `1500` | `POLICY_SETTLE_MS` of the agent (wait after a policy is ACTIVE before telling the customer a rule is in force) |
| `policyValidationMode` | `FAIL_ON_ANY_FINDINGS` | or `IGNORE_ALL_FINDINGS` if AgentCore's Cedar validator rejects a default policy |
| `runtimeArtifact` | `code` | `code` = S3 zip (direct code deployment); `container` = ECR image from `agent/Dockerfile` and `server/Dockerfile` (needs Docker) |
| `debugApi` | `true` | `false` removes the debug Lambda and its Function URL |
| `householdId`, `defaultTimezone`, `region`, `distDir` | `hh_demo`, `America/New_York`, `us-east-1`, `dist` | |
| `stubAssets` | `false` | unit tests only |

## Deploying

`scripts/deploy.sh` prints the ordered commands and **does nothing else** unless you pass `--yes`:

```bash
bash infra/scripts/deploy.sh                                   # print the plan
SES_FROM_ADDRESS=you@yourdomain BUDGET_EMAIL=you@yourdomain bash infra/scripts/deploy.sh --yes [--bootstrap]
```

The commands it runs, in order:

1. `aws sso login --profile butler-dev` (your session), then once per account/region: `cd infra && npx cdk bootstrap aws://<account>/us-east-1` (only with `--bootstrap`)
2. `pnpm install && uv sync`, then `pnpm typecheck && pnpm test && pnpm test:python`
3. `pnpm build:lambdas && pnpm build:runtimes`
4. `npx cdk synth -c stage=dev -c SES_FROM_ADDRESS=... -c budgetEmail=...`
5. `npx cdk deploy butler-dev -c stage=dev ...` (CDK still asks you to approve IAM changes)
6. manual one-time steps below
7. `uv run python infra/scripts/seed_aws.py --stage dev`

`cdk destroy butler-dev -c stage=dev -c account=...` removes everything (table, runtimes, gateway, policies). **Secrets Manager keeps
deleted secrets for 30 days**, so re-deploying the same stage right after a destroy fails on the secret names; after a destroy run
`aws secretsmanager delete-secret --secret-id butler/dev/<name> --force-delete-without-recovery` for the seven `butler/dev/*`
secrets (or wait). The CDK bootstrap stack and its asset bucket stay.

## Manual one-time steps

1. **SES**: click the verification link SES mails to `SES_FROM_ADDRESS` and to each `sesRecipients` address. The account stays in the
   SES sandbox (that is intended: `SES_SANDBOX=true`, SES_ALLOWED_RECIPIENTS = saved contacts + `sesRecipients`).
2. **Google Calendar**: run the S-6 OAuth script with the demo Google account, then store the result as JSON in
   `butler/{stage}/google-refresh-token`:
   `{"client_id": "...", "client_secret": "...", "refresh_token": "..."}` (the actions Lambda reads it through `GOOGLE_OAUTH_SECRET_ID`).
3. **Payments**: put the provider's **test** secret key (`sk_test_...`) as a plain string in `butler/{stage}/payment-key`. The code refuses
   non-test keys. Until steps 2 and 3 are done, deploy with `-c adapters=fake`, or leave the placeholders: read-only tools work, and
   a real checkout/calendar call returns `UPSTREAM_UNAVAILABLE`.
4. **Bedrock**: enable model access for the planner and fast models in `us-east-1` and submit the Anthropic use-case form (the
   2026-10-06 check in `handoff/CONTRACT-REQUESTS.md` still returned `AccessDeniedException`/`ResourceNotFoundException`).
5. **AgentCore availability**: confirm Gateway, Policy and Runtime (direct code deployment) are enabled for the account in
   `us-east-1` before the first `cdk deploy` (S-1). A first deploy failing on `AWS::BedrockAgentCore::*` means this.
6. **Seed**: `uv run python infra/scripts/seed_aws.py --stage dev [--reset]`. It reuses the loader (household, contacts, history,
   default rules compiled with the real client ids) against the real table and then points each default rule record at the deployed
   policy (`seed/load.py` alone would store fake `local-*` policy ids and `remove_rule` on a default rule would leave the real policy
   enforcing). It reads `/butler/{stage}/*` from SSM and calls `bedrock-agentcore-control:ListPolicies`.
7. **Debug API token**: `butler/{stage}/debug-api-token` is generated at deploy. Copy it into the Butler panel (`DEBUG_API_TOKEN`) and
   rotate it before recording (P-10); redeploy or update the secret and the Lambda environment. The token is a Lambda environment
   variable (plain text in the console to anyone with `lambda:GetFunctionConfiguration`).

### Using the outputs

`cdk deploy` prints, and SSM `/butler/{stage}/*` holds: `GatewayUrl`, `McpServerUrl` (give this to the simulator), `DebugApiUrl`,
`TokenUrl`, `DiscoveryUrl`, `SimClientId`, `TableName`, the runtime ARNs. The simulator needs a Bearer token from the token URL:

```bash
SECRET=$(aws secretsmanager get-secret-value --secret-id butler/dev/sim-client --query SecretString --output text)
curl -s -X POST "$TOKEN_URL" -d grant_type=client_credentials -d client_id="$SIM_CLIENT_ID" -d client_secret="$SECRET" -d scope=butler/invoke
```

## Least privilege (ticket P-1)

| Principal | Can | Cannot |
|---|---|---|
| executor Lambda role | its table access, **read `butler/{stage}/executor-client` only** | agent/Google/payment secrets, policy management, Bedrock |
| agent runtime role | table access, **read `.../agent-client` only**, Bedrock invoke (the two configured models), create/get/list/update/delete policies on the one engine | executor secret; it holds a token provider for `butler-agent` only, never `approval-executor` |
| server runtime role | table access, Bedrock (fast model), `InvokeAgentRuntime` on the agent runtime, `lambda:InvokeFunction` on the executor | every secret, policy management |
| actions Lambda role | table access, Google + payment secrets, `ses:SendEmail` **from the configured identity only** | agent/executor secrets |
| debug API role | table **read** | writes, secrets |
| Gateway role | invoke the actions function, evaluate the policy engine | |

`test/stack.test.ts` asserts the secret separation, the SES scope, and that no `secretsmanager:`/`dynamodb:` statement anywhere has a
bare `*` resource. The runtime roles also get the L2 defaults (logs, X-Ray, workload identity) and read access to the CDK asset
bucket (the code zip lives there).

## Deviations from the handoff docs and gaps found in the application

* **Env var names follow the code, not `03-environment.md`**: `SES_FROM` (not `SES_FROM_ADDRESS`), `GOOGLE_OAUTH_SECRET_ID` (a JSON secret) and
  `EXECUTOR_CLIENT_SECRET` / `STRIPE_SECRET_KEY` (raw values). The thin entries resolve `EXECUTOR_CLIENT_SECRET_ARN` /
  `PAYMENT_SECRET_ARN` from Secrets Manager at cold start so the roles can be scoped to single secrets.
* **The agent cannot authenticate to the Gateway as written**: `butler_agent.factory.build_gateway()` only uses the static local tokens
  (`AGENT_TOKEN`). `infra/runtime/agent_entry.py` (the runtime entrypoint) installs a Cognito client-credentials client for `butler-agent`
  before starting `butler_agent.server`. The proper fix is two lines in the factory (what `butler_executor.handler.default_gateway`
  already does); then the shim can be deleted.
* The seed loader's AWS path is `infra/scripts/seed_aws.py` (see manual step 6). `seed --reset` still does not delete the real policies of
  non-default rules (A-14 says it should).
* Tool schemas keep the contract's `idempotency_key`, `correlation_id`, `plan_id`, `need_id` (the wrapper sends them) and omit `reasoning`
  (the wrapper strips it). The CloudFormation `SchemaDefinition` has no `enum`/`additionalProperties`, so enum values are in the field
  descriptions and the Lambdas' re-validation is the enforcement. Policy fields (`amount_minor` integer and required on checkout/book_service,
  `category` string required on checkout, `event_owner` string required on update/delete, `recipient_email` string, `recipient_contact_ids`
  array of string) are typed exactly (`test/tool-schemas.test.ts`).
* Gateway search is not enabled (no `SEMANTIC` search tool), so `tools/list` returns only the 12 tools.

## UNVERIFIED until first deploy

Everything below was designed from the docs, the CDK type definitions and the application code; none of it could be exercised offline.
"Verified" in this repo means synth, vitest, `cfn-lint` and local runs only.

**CloudFormation level**
* `cfn-lint 1.46` (an older resource-spec snapshot) lints the template clean *except* it does not know `AWS::BedrockAgentCore::PolicyEngine`,
  `::Policy`, `Gateway.PolicyEngineConfiguration`, or Runtime `NODE_22`. `aws-cdk-lib 2.272` has all of them, so CloudFormation should, but the
  first deploy is the real test. If CloudFormation rejects the policy resources, decision D18's fallback is
  `butler_rules.ensure_policy_engine` / `attach_engine_to_gateway` / `AgentCorePolicyService` (already written, never run against AWS).
* Property validity beyond the CDK constructs' own client-side checks (name patterns, lengths) is unchecked.

**AgentCore Runtime (direct code deployment instead of containers)**
* That both runtimes really accept `codeConfiguration`: Python 3.12 for the agent, **Node 22** for the server (so no Docker at all). The L2 allows it; the
  service behaviour is unproven. Fallback: `-c runtimeArtifact=container` (`agent/Dockerfile` is new and untested; `server/Dockerfile` was "not built in CI").
* Entrypoints `["agent_entry.py"]` and `["entry.mjs"]`: whether the platform runs them as `python agent_entry.py` / `node entry.mjs` from the
  zip root with dependencies next to the code (that is how the zips are laid out). `opentelemetry-instrument` is not wrapped around the agent.
* That the platform reaches `0.0.0.0:8080` (`/invocations`, `/ping`) for HTTP and `0.0.0.0:8000/mcp` for MCP, and that `PORT` need not be set.
* `requestHeaderConfiguration.allowlistedHeaders: ["Authorization"]`: the server needs the bearer token to pick the household; if the
  platform does not forward it every request is a 401. (`x-correlation-id` is not forwardable, so the server generates its own.)
* The JWT authorizer of the server runtime: allowed-clients matching the `client_id` claim of Cognito client-credentials tokens (they have no `aud`),
  `allowedScopes` semantics, and that the MCP URL `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<url-encoded-arn>/invocations?qualifier=DEFAULT`
  (built in `runtimes.ts`) is the right shape.
* The pre-created log groups `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` (a wrong name just leaves an unused group).
* Session behaviour, concurrency quotas, cold-start time of the 58 MB agent zip, and that boto3 inside the zip is picked up.

**Gateway, targets, Cedar policy**
* `GatewayUrl` includes the `/mcp` path (the agent and executor use it verbatim as `GATEWAY_URL`), and the Gateway accepts a bare `tools/call`
  without `initialize` (the clients send none).
* The tool-name delimiter `___` and the exact value of `context.client_context.custom["bedrockAgentCoreToolName"]` (the entry tolerates a prefix or a bare name).
* `allowedClients` + `allowedScopes` accepted for the Gateway and a Cognito `client_credentials` token passes (`butler/invoke`).
* **Policy validation**: `FAIL_ON_ANY_FINDINGS` may reject a default policy (guarded `getTag`, `context.input` fields typed from the inline schemas, `resource is AgentCore::Gateway`,
  the `@id("...")` annotation). If so, a failed deploy rolls back; re-run with `-c policyValidationMode=IGNORE_ALL_FINDINGS` and read the findings.
  The policies are created after the gateway and all five targets (`DependsOn`) and one at a time (the L2 chains them).
* That `principal.getTag("sub")` equals the Cognito **client id** for client-credentials tokens (D9); the whole agent-vs-executor distinction rests on it.
* **How a policy denial surfaces** to the caller. `classify_gateway_response` tolerates 403, JSON-RPC error codes and `isError` text; the real shape
  is still the open S-1 item. A type confusion in a field fails open in Cedar, which is why the fields are typed and re-validated by the wrapper and Lambdas.
* **Propagation time** from policy ACTIVE to enforcement: `POLICY_SETTLE_MS` defaults to 1500, a guess. Measure it (P-5/P-6) and set `-c policySettleMs`.
* The IAM actions granted to the agent role for rule management (`CreatePolicy`, `GetPolicy`, `ListPolicies`, `UpdatePolicy`, `DeletePolicy`, `GetPolicyEngine`,
  `ManageAdminPolicy`, `ManageResourceScopedPolicy`) and their resource ARN shapes (`<engine-arn>/policy/*`) are inferred; an `AccessDenied` on `apply_rule` means a name or ARN is off.

**Other AWS services**
* Cognito: the domain prefix `butler-{stage}-{account}` is free; the client secrets are read by CloudFormation through the L2's describe custom resource.
* SES: identities verify; the sandbox allows the verified recipients; `ses:FromAddress` condition is satisfied by the `Source` the adapter sends.
* The Google OAuth JSON and payment key formats match what the adapters read (checked against the code, not against the providers).
* Bedrock IAM: the foundation-model ARN is derived by stripping the `us.` prefix from the inference-profile id; a model whose id does not follow that pattern needs the context overrides and may need ARN edits.
* Budgets: one account-wide monthly $100 budget with notifications at 50% and 100% of actual spend (it cannot be scoped to this stack).
* Lambda Function URL for the debug API without IAM auth, token from the environment (contracts section 11).
* Seed linker `seed_aws.py` and the `agent_entry.py` shim are unit-tested against fakes/moto only.

## Cost (rough, check current pricing)

Fixed, idle: Secrets Manager 7 secrets about $2.8/month; three Cognito machine-to-machine clients are billed per client (on the order of
$6/month each plus a per-token charge; the largest fixed item); DynamoDB on-demand, Lambda, SES sandbox, SSM standard parameters and 14-day
logs are cents at demo scale; the first two Budgets are free. AgentCore Runtime/Gateway/Policy are consumption based (no charge idle,
small per-invocation/authorisation fees). **Bedrock tokens dominate**: a rehearsal run is a handful of Sonnet-class planner loops (up to 25 tool
steps each) and some fast-model calls, so budget a few dollars per rehearsal day and keep `llmMode=offline` for load tests. Expect roughly
$20 to $30 a month fixed plus usage; the $50/$100 alarms are the guard. `cdk destroy` the dev stage when idle.

## Layout

```
bin/butler.ts                 entry (reads -c stage)
lib/config.ts                 context -> config
lib/butler-stack.ts           the stack: composition, SSM parameters, outputs
lib/constructs/{data,auth,lambdas,agentcore,runtimes,ops}.ts
lib/tool-schemas.ts           contracts -> Gateway inline tool schemas
lib/policies.ts, lib/assets.ts
scripts/{build-lambdas,build-runtimes,deploy}.sh, gen-policies.py, seed_aws.py
runtime/agent_entry.py        agent runtime entrypoint (Cognito gateway shim) + tests in runtime/tests
generated/policies.json       committed output of gen-policies.py
test/*.test.ts                vitest + aws-cdk-lib/assertions
dist/  cdk.out/               build output (git-ignored)
```
