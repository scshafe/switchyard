# Your first switchyard

This guide takes you from an empty directory to watching units move through a
small switchyard graph whose state lives in PostgreSQL. It takes about twenty
minutes. You need no model server: the models are a few lines of fake,
deterministic code, and a later step shows where a real one plugs in.

Everything you type is in this guide, in order. The finished project is in
[`first-graph-example/`](first-graph-example/), byte for byte the files below
(plus the `pnpm-lock.yaml` of the author's run).

The guide uses the published packages `@scshafe/switchyard` **2.2.0** and
`@scshafe/switchyard-postgres` **0.1.1**. Switchyard 2.3.0 (not published yet)
adds helpers that shorten three of the files; see
[With switchyard 2.3.0](#with-switchyard-230).

## What you will build

Messages arrive. A small local model decides whether each one is a question.
A "cloud" model drafts an answer, but only after a local model has checked
that the text holds no personal data. Code turns the draft into a reply, and
a person reviews the reply before it is done.

```
message --> is-question --yes--> draft-answer --drafted--> compose-reply --> done
            small model          "cloud" model             code
            |                    ^                         |
            | unsure             | runs only if a local    | a person reviews
            v                    | model approves first    | the reply after
            a person answers     | (the PII screen)        | it runs
            yes or no
```

Three nodes you write, three ideas:

1. **`is-question`**: a small model answers one yes/no question, and may say
   `unsure`; `unsure` goes to a person (`binaryQuestion`).
2. **`draft-answer`**: a model node with a **model approval** before it runs.
3. **`compose-reply`**: a code node with a **human review** after it runs.

## Prerequisites

- A Linux or macOS shell (the guide was run on Arch Linux).
- **Node.js 22.22 or later 22.x, or 24.18 or later 24.x.** Check with
  `node -v`.
- **pnpm 10.** If `pnpm -v` does not print `10.x`, get it with corepack,
  which ships with Node 22 and 24: `corepack enable pnpm`, then
  `corepack prepare pnpm@10 --activate`. Or with npm:
  `npm install -g pnpm@10`.
- **Docker**, able to run containers as your user (rootless is fine). Check
  with `docker run --rm hello-world`.
- **A GitHub account that can read the `@scshafe` packages**, and a
  **classic personal access token with only the `read:packages` scope**
  (step 1).

## 1. Let pnpm read `@scshafe` packages

The packages are private, on GitHub Packages. pnpm needs a token to download
them. GitHub Packages' npm registry accepts only **classic** tokens, not
fine-grained ones.

1. On GitHub, open **Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate new token (classic)**.
2. Give it a name (e.g. `read scshafe packages`), an expiry, and tick
   **only `read:packages`**. Generate it and copy the `ghp_...` value.
3. Put it in your **user-level** npm config, `~/.npmrc`, never in a project:

   ```sh
   touch ~/.npmrc && chmod 600 ~/.npmrc
   ${EDITOR:-nano} ~/.npmrc
   ```

   Add this line, with your token in place of `ghp_YOUR_TOKEN`, and save:

   ```ini
   //npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN
   ```

You check that it works in the next step.

## 2. Create the project

```sh
mkdir first-switchyard
cd first-switchyard
```

Every command from here on runs in `first-switchyard/`.

Create `package.json` with this content (or run `pnpm init` and replace what
it wrote):

```json
{
  "name": "first-switchyard",
  "version": "1.0.0",
  "private": true,
  "description": "My first switchyard graph.",
  "engines": {
    "node": ">=22.22.0 <23 || >=24.18.0 <25"
  }
}
```

Create `.npmrc`. It tells pnpm that `@scshafe/*` packages come from GitHub
Packages. It holds no credential, so it is safe to commit:

<!-- file: .npmrc -->
```ini
@scshafe:registry=https://npm.pkg.github.com
```

Check that pnpm can see the packages:

```sh
pnpm view @scshafe/switchyard@2.2.0 version
```

```
2.2.0
```

If this fails, see [Troubleshooting](#troubleshooting). Now install the
engine, the Postgres stores, and `pg` (the Postgres client; your code creates
the connection pool, so it is a direct dependency):

```sh
pnpm add --save-exact @scshafe/switchyard@2.2.0 @scshafe/switchyard-postgres@0.1.1 pg@8.23.0
```

The progress lines vary; the output ends with:

```
dependencies:
+ @scshafe/switchyard 2.2.0
+ @scshafe/switchyard-postgres 0.1.1
+ pg 8.23.0
```

`package.json` now reads:

<!-- file: package.json -->
```json
{
  "name": "first-switchyard",
  "version": "1.0.0",
  "private": true,
  "description": "My first switchyard graph.",
  "engines": {
    "node": ">=22.22.0 <23 || >=24.18.0 <25"
  },
  "dependencies": {
    "@scshafe/switchyard": "2.2.0",
    "@scshafe/switchyard-postgres": "0.1.1",
    "pg": "8.23.0"
  }
}
```

## 3. Start PostgreSQL and create the schema

Start PostgreSQL 18 in Docker, reachable only from this machine:

```sh
docker run -d --name first-switchyard-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=devpassword postgres:18
```

The first time, Docker downloads the image, then prints the new container's
id. Wait until the server accepts connections (a few seconds):

```sh
until docker exec first-switchyard-db pg_isready -h 127.0.0.1 -q; do sleep 1; done
```

Create the switchyard schema. `migrate` runs as the database owner
(`postgres` here), creates the schema `switchyard` and two roles without
login, `switchyard_runtime` (may call the store routines, nothing else) and
`switchyard_reader` (may read every table and view):

```sh
pnpm exec switchyard-postgres migrate --url postgres://postgres:devpassword@127.0.0.1:5432/postgres
```

```
{"schema":"switchyard","applied":[1,2,3],"currentVersion":3,"roles":{"runtime":"switchyard_runtime","reader":"switchyard_reader"}}
```

`migrate` is idempotent: run it again and `applied` is `[]`.

Create two login roles: `app` for your scripts (a member of the runtime role)
and `watcher` for looking at the data (a member of the reader role):

```sh
docker exec first-switchyard-db psql -U postgres \
  -c "CREATE ROLE app LOGIN PASSWORD 'app' IN ROLE switchyard_runtime;" \
  -c "CREATE ROLE watcher LOGIN PASSWORD 'watcher' IN ROLE switchyard_reader;"
```

```
CREATE ROLE
CREATE ROLE
```

Create `.env`. Every script reads its connection from here (Node's
`--env-file` loads it):

<!-- file: .env -->
```sh
APP_DATABASE_URL=postgres://app:app@127.0.0.1:5432/postgres
```

## 4. Write the graph

A graph is data: nodes, the edges between them, and the ends. You write it
once; `createGraphDefinition` checks it and seals it with a digest.

Create `graph.mjs`:

<!-- file: graph.mjs -->
```js
// graph.mjs: the graph. Three authored nodes, sealed into one definition.
//
//   is-question    a small local model answers yes / no / unsure;
//                  unsure goes to a person
//   draft-answer   a "cloud" model drafts an answer, but only after a
//                  local model has approved the text (a PII screen)
//   compose-reply  code turns the draft into a reply, and a person
//                  reviews it after it runs
import {
  NODE_TURN_IDEMPOTENCY,
  NODE_TURN_RETRY_TAXONOMY,
  binaryQuestion,
  createGraphDefinition,
  digest
} from "@scshafe/switchyard";

// Contracts name the shape of the data travelling along an edge.
export const TICKET = "ticket.v1"; // { text }
export const DRAFT = "draft.v1"; // { question, answer }
export const REPLY = "reply.v1"; // { body }

// A principal is "who may run this node". Workers claim turns per principal.
export const PRINCIPALS = {
  local: "local-model",
  cloud: "cloud-model",
  worker: "worker",
  person: "console"
};

// How one turn of a node is run: lease length and retry budget.
const turn = {
  idempotency: NODE_TURN_IDEMPOTENCY,
  retryTaxonomy: NODE_TURN_RETRY_TAXONOMY,
  leaseMs: 30_000,
  maxAttempts: 3
};

// A binding names exactly which model a node runs on. Its digest is part of
// the graph's digest: point a node at another model and it is a new graph.
const binding = (bindingId, model) => ({
  kind: "model",
  bindingId,
  version: 1,
  bindingDigest: digest(model)
});
export const BINDINGS = {
  small: binding("small-local", { model: "qwen2.5-7b", where: "local" }),
  cloud: binding("big-cloud", { model: "big-cloud-model", where: "cloud" })
};

// Actors approve or review. Either a person or a model.
const person = { kind: "human", principal: { id: PRINCIPALS.person } };
const piiScreen = {
  kind: "model",
  binding: BINDINGS.small,
  principal: { id: PRINCIPALS.local }
};

// Node 1: one yes/no question for a small model. "unsure" goes to a person.
const isQuestion = binaryQuestion({
  nodeId: "is-question",
  ref: { id: "first.is-question", version: 1 },
  input: TICKET,
  principal: { id: PRINCIPALS.local },
  binding: BINDINGS.small,
  turn,
  escalate: person,
  yes: { to: "draft-answer" },
  no: "terminal"
});

export const graph = createGraphDefinition({
  graphId: "first-switchyard",
  version: 1,
  description: "Triage a message, draft an answer behind a PII screen, have a person review the reply.",
  entry: "is-question",
  nodes: [
    ...isQuestion.nodes,
    // Node 2: a model node with a model approval before it runs.
    {
      nodeId: "draft-answer",
      ref: { id: "first.draft-answer", version: 1 },
      kind: "model",
      input: TICKET,
      outcomes: { version: 1, outcomes: ["drafted"] },
      outputs: { drafted: DRAFT },
      principal: { id: PRINCIPALS.cloud },
      binding: BINDINGS.cloud,
      turn,
      approval: { by: piiScreen, onDeny: "terminal" }
    },
    // Node 3: a code node with a human review after it runs.
    {
      nodeId: "compose-reply",
      ref: { id: "first.compose-reply", version: 1 },
      kind: "code",
      input: DRAFT,
      outcomes: { version: 1, outcomes: ["composed"] },
      outputs: { composed: REPLY },
      principal: { id: PRINCIPALS.worker },
      turn,
      review: { by: person, onReject: "terminal", maxRounds: 2 }
    }
  ],
  edges: [
    ...isQuestion.edges,
    {
      edgeId: "draft-answer.drafted",
      from: "draft-answer",
      when: { outcome: "drafted" },
      to: ["compose-reply"]
    }
  ],
  terminals: [
    ...isQuestion.terminals,
    { nodeId: "compose-reply", outcome: "composed" }
  ]
});
```

Things to notice:

- `binaryQuestion` builds node 1 for you: a model node with the outcomes
  `yes | no | unsure`, plus a node for the person who answers when the model
  is unsure. You spread its nodes, edges and ends into the graph.
- `approval` and `review` are settings on a node. You do not write the
  approval or review nodes yourself.
- Every outcome must go somewhere: along an edge, or to an end
  (`terminals`). `createGraphDefinition` refuses a graph where an outcome
  goes nowhere.

Create `show-graph.mjs` to see what was sealed:

<!-- file: show-graph.mjs -->
```js
// show-graph.mjs: print the sealed graph. Approval and review are nodes now.
import { graph } from "./graph.mjs";

console.log(`graph ${graph.graphId} v${graph.version}, digest ${graph.graphDigest.slice(0, 16)}...`);
console.log("nodes:");
for (const node of graph.nodes) {
  const outcomes = node.outcomes.outcomes.join(" | ");
  console.log(`  ${node.nodeId.padEnd(24)} ${node.kind.padEnd(6)} ${node.principal.id.padEnd(12)} ${outcomes}`);
}
console.log("edges:");
for (const edge of graph.edges) {
  const when = edge.when.outcome ?? edge.when.anyOf.join("|");
  console.log(`  ${edge.from} --${when}--> ${edge.to.join(", ")}`);
}
console.log("ends:");
for (const end of graph.terminals) console.log(`  ${end.nodeId} --${end.outcome}--> (done)`);
```

```sh
node show-graph.mjs
```

```
graph first-switchyard v1, digest b4debcf9ae48344b...
nodes:
  is-question              model  local-model  yes | no | unsure
  is-question.escalate-1   human  console      yes | no
  draft-answer::approval   model  local-model  approved | denied
  draft-answer             model  cloud-model  drafted
  compose-reply            code   worker       composed
  compose-reply::review    human  console      accepted:composed | rework | rejected
  compose-reply::rework    code   worker       composed
edges:
  is-question --yes--> draft-answer::approval
  is-question --unsure--> is-question.escalate-1
  is-question.escalate-1 --yes--> draft-answer::approval
  draft-answer --drafted--> compose-reply
  draft-answer::approval --approved--> draft-answer
  compose-reply --composed--> compose-reply::review
  compose-reply::review --rework--> compose-reply::rework
  compose-reply::rework --composed--> compose-reply::review
ends:
  is-question --no--> (done)
  is-question.escalate-1 --no--> (done)
  compose-reply::review --accepted:composed--> (done)
  draft-answer::approval --denied--> (done)
  compose-reply::review --rejected--> (done)
```

You wrote three nodes; the sealed graph has seven. `binaryQuestion` added
`is-question.escalate-1` (the person). The `approval` setting became
`draft-answer::approval`, which now comes before `draft-answer`: the edge
from `is-question` points at it. The `review` setting became
`compose-reply::review` (a person answers `accepted` or `rejected`) and
`compose-reply::rework` (the same code runs again with the reviewer's notes,
here at most once more, because `maxRounds: 2`). They are ordinary nodes with
their own queues.

## 5. The model

Switchyard calls your code through **ports**, one per kind of node. The model
port has one method, `invoke(input, binding, context)`: `input` is the data
the node receives, `binding` says which model the node runs on, and
`context.nodeId` says which node is asking. It returns an outcome, optionally
an artifact to pass on, and exactly one usage receipt.

Create `models.mjs`. The fake model answers from simple rules on the text,
so a given message always gets the same answers:

<!-- file: models.mjs -->
```js
// models.mjs: the model port. switchyard calls invoke() for every model
// turn: is-question, draft-answer::approval (the PII screen) and draft-answer.
//
// fakeModel answers from simple rules on the text, so the same input always
// gets the same answer and no model server is needed. realModel (in
// real-model.mjs) asks an OpenAI-compatible server instead.
import { createArtifactEnvelope } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

// Every model turn must return exactly one usage receipt. A fake model has
// no provider telemetry, so it charges the smallest allowed amount.
export function noTelemetryReceipt(durationMs) {
  return {
    schemaVersion: "usage-receipt.v1",
    trust: "unavailable",
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: 1,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 1,
    durationMs
  };
}

const PERSONAL_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\d{3}[\s-]?\d{3}[\s-]?\d{4}/;

function fakeAnswer(nodeId, text) {
  switch (nodeId) {
    case "is-question": // "Is this message a question we should answer?"
      if (text.trim().endsWith("?")) return { outcome: "yes" };
      if (/unsubscribe|buy now/i.test(text)) return { outcome: "no" };
      return { outcome: "unsure" };
    case "draft-answer::approval": // "May this text go to a cloud model?"
      return { outcome: PERSONAL_DATA.test(text) ? "denied" : "approved" };
    case "draft-answer": // the "cloud" model writes a draft
      return {
        outcome: "drafted",
        outputArtifact: createArtifactEnvelope(DRAFT, {
          question: text,
          answer: `Thanks for asking. (echo) ${text}`
        })
      };
    default:
      throw new Error(`fake model has no rule for node ${nodeId}`);
  }
}

export const fakeModel = {
  async invoke(input, binding, context) {
    const started = Date.now();
    const answer = fakeAnswer(context.nodeId, input.text);
    return { ...answer, usage: [noTelemetryReceipt(Date.now() - started)] };
  }
};
```

- `is-question`: a message ending in `?` is a question; one that says "buy
  now" is not; anything else is `unsure`.
- `draft-answer::approval`, the PII screen: an email address or a phone
  number means `denied`, and the text never reaches `draft-answer`.
- `draft-answer`: echoes the question into a draft.

## 6. Connect and admit units

Create `db.mjs`. It opens a pool as the `app` role and builds the three
stores switchyard-postgres provides:

<!-- file: db.mjs -->
```js
// db.mjs: one connection pool and the three Postgres stores.
import pg from "pg";
import { createPostgresStores } from "@scshafe/switchyard-postgres";

export function openStores() {
  // APP_DATABASE_URL logs in as a member of switchyard_runtime: it can call
  // the store routines and nothing else.
  const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
  pool.on("error", (error) => console.error("idle PostgreSQL client failed", error));
  return { pool, ...createPostgresStores({ pool }) };
}
```

Create `admit.mjs`. It publishes the graph (publishing the same sealed graph
again changes nothing) and admits one **unit**, a message that travels
through the graph:

<!-- file: admit.mjs -->
```js
// admit.mjs: publish the graph and admit one unit (a message) into it.
//   node --env-file=.env admit.mjs <unit-id> "<text>"
import { createArtifactEnvelope, graphDefinitionRef } from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { TICKET, graph } from "./graph.mjs";

const [unitId, text] = process.argv.slice(2);
if (unitId === undefined || text === undefined) {
  console.error('usage: node --env-file=.env admit.mjs <unit-id> "<text>"');
  process.exit(2);
}

const { pool, graphStore, unitStore } = openStores();
try {
  // Publishing the same sealed graph again is a no-op.
  await graphStore.publishGraph(graph);
  const { created, entryQueue } = await unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope(TICKET, { text }),
    admittedAt: new Date().toISOString(),
    principalId: "admitter"
  });
  console.log(`${created ? "admitted" : "already admitted"} ${unitId}: queued at ${entryQueue.nodeId}`);
} finally {
  await pool.end();
}
```

Admit five messages:

```sh
node --env-file=.env admit.mjs u1 "What are your opening hours?"
node --env-file=.env admit.mjs u2 "My email is jane@example.com, why was I charged twice?"
node --env-file=.env admit.mjs u3 "I need to talk to someone about my order"
node --env-file=.env admit.mjs u4 "Buy now! Cheap watches"
node --env-file=.env admit.mjs u5 "Do you ship to Canada?"
```

```
admitted u1: queued at is-question
admitted u2: queued at is-question
admitted u3: queued at is-question
admitted u4: queued at is-question
admitted u5: queued at is-question
```

Nothing has run yet. Each unit is waiting in the queue of the entry node.

## 7. Watch from the database

Create `watch.sql`. It uses the views switchyard-postgres provides:
`switchyard.turns` has one row per visit of a unit to a node, with its
status (`queued`, `leased`, `settled` or `failed`) and outcome.

<!-- file: watch.sql -->
```sql
-- watch.sql: run as the read-only role (a member of switchyard_reader).

\echo '== Where every unit is waiting (position 1 = next in that node''s queue)'
SELECT node_id, unit_id, status,
       rank() OVER (PARTITION BY node_id ORDER BY enqueue_sequence) AS position,
       node_kind, principal_id
FROM switchyard.turns
WHERE status IN ('queued', 'leased')
ORDER BY node_id, position;

\echo '== The journey of each unit: every node it passed through, in order'
SELECT unit_id, enqueue_sequence AS seq, node_id, status, outcome,
       actor_id AS decided_by, attempts
FROM switchyard.turns
ORDER BY unit_id, enqueue_sequence;

\echo '== Each unit''s state and its last step'
SELECT unit_id,
       CASE WHEN bool_or(status IN ('queued', 'leased')) THEN 'in progress'
            WHEN bool_or(status = 'failed') THEN 'failed'
            ELSE 'finished' END AS state,
       (array_agg(node_id || ' -> ' || coalesce(outcome, error_code, status)
                  ORDER BY enqueue_sequence DESC))[1] AS last_step
FROM switchyard.turns
GROUP BY unit_id
ORDER BY unit_id;

\echo '== Decisions people made'
SELECT unit_id, node_id, outcome, actor_id, settled_at
FROM switchyard.human_decisions
ORDER BY decision_sequence;

\echo '== Replies a person accepted'
SELECT settlement.unit_id,
       artifact.envelope::json #>> '{payload,body}' AS reply
FROM switchyard.turn_settlements AS settlement
JOIN switchyard.artifacts AS artifact
  ON artifact.contract_id = settlement.output_contract_id
 AND artifact.artifact_digest = settlement.output_artifact_digest
WHERE settlement.node_id = 'compose-reply::review'
  AND settlement.outcome = 'accepted:composed'
ORDER BY settlement.settlement_sequence;
```

Run it as `watcher`, the read-only role, with the `psql` inside the
container:

```sh
docker exec -i -e PGPASSWORD=watcher first-switchyard-db \
  psql -h 127.0.0.1 -U watcher -d postgres < watch.sql
```

```
== Where every unit is waiting (position 1 = next in that node's queue)
   node_id   | unit_id | status | position | node_kind | principal_id 
-------------+---------+--------+----------+-----------+--------------
 is-question | u1      | queued |        1 | model     | local-model
 is-question | u2      | queued |        2 | model     | local-model
 is-question | u3      | queued |        3 | model     | local-model
 is-question | u4      | queued |        4 | model     | local-model
 is-question | u5      | queued |        5 | model     | local-model
(5 rows)

== The journey of each unit: every node it passed through, in order
 unit_id | seq |   node_id   | status | outcome | decided_by | attempts 
---------+-----+-------------+--------+---------+------------+----------
 u1      |   1 | is-question | queued |         |            |        0
 u2      |   2 | is-question | queued |         |            |        0
 u3      |   3 | is-question | queued |         |            |        0
 u4      |   4 | is-question | queued |         |            |        0
 u5      |   5 | is-question | queued |         |            |        0
(5 rows)

== Each unit's state and its last step
 unit_id |    state    |       last_step       
---------+-------------+-----------------------
 u1      | in progress | is-question -> queued
 u2      | in progress | is-question -> queued
 u3      | in progress | is-question -> queued
 u4      | in progress | is-question -> queued
 u5      | in progress | is-question -> queued
(5 rows)

== Decisions people made
 unit_id | node_id | outcome | actor_id | settled_at 
---------+---------+---------+----------+------------
(0 rows)

== Replies a person accepted
 unit_id | reply 
---------+-------
(0 rows)
```

All five units wait at `is-question`, first come first served.

## 8. Run the worker

The worker claims queued turns and runs them. A turn is claimed by a
**principal**, the identity a node runs as (`local-model`, `cloud-model`,
`worker` in `graph.mjs`), and a claim takes a batch of units waiting at the
same node. The worker asks for each principal in turn, runs the batch through
the ports, and repeats. Switchyard 2.2.0 gives you the pieces
(`runNextUnitTurns`) but not the loop; this file is the loop.

Create `worker.mjs`:

<!-- file: worker.mjs -->
```js
// worker.mjs: the worker loop. It claims queued turns for every worker
// principal in the graph, runs them through the ports, and repeats.
//   node --env-file=.env worker.mjs               keep polling (Ctrl-C stops)
//   node --env-file=.env worker.mjs --until-idle  stop when nothing is queued
import { setTimeout as sleep } from "node:timers/promises";

import {
  codeNodePortByNode,
  createArtifactEnvelope,
  runNextUnitTurns,
  withApprovalReviewPorts
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { REPLY, graph } from "./graph.mjs";
import { fakeModel } from "./models.mjs";

// Code bodies, one per code node. A review rejection runs the same body
// again at "compose-reply::rework", with the reviewer's notes in its input.
async function composeReply(input, context) {
  const rework = context.nodeId === "compose-reply::rework";
  const draft = rework ? input.input.payload : input;
  const notes = rework ? input.history.at(-1).feedback?.payload.notes : undefined;
  const lines = ["Hello,", "", draft.answer];
  if (notes) lines.push("", `(Revised after review: ${notes})`);
  lines.push("", "-- The team");
  return {
    outcome: "composed",
    outputArtifact: createArtifactEnvelope(REPLY, { body: lines.join("\n") })
  };
}

let model = fakeModel;
if (process.env.MODEL_BASE_URL) {
  model = (await import("./real-model.mjs")).realModel;
}

// withApprovalReviewPorts builds the records that reviewers and rework
// rounds see. Without it, reviewed nodes fail closed.
const ports = withApprovalReviewPorts(
  {
    code: codeNodePortByNode({
      "compose-reply": composeReply,
      "compose-reply::rework": composeReply
    }),
    model
  },
  { graphs: [graph] }
);

// Every principal that runs code, model or agent nodes. Human nodes wait for
// decide.mjs instead.
const principals = [
  ...new Set(
    graph.nodes
      .filter((node) => node.kind === "code" || node.kind === "model" || node.kind === "agent")
      .map((node) => node.principal.id)
  )
];

const untilIdle = process.argv.includes("--until-idle");
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const { pool, unitStore } = openStores();
console.log(`worker: principals ${principals.join(", ")}`);
try {
  while (!stop.signal.aborted) {
    let ran = 0;
    for (const principalId of principals) {
      const settled = await runNextUnitTurns({
        store: unitStore,
        principalId,
        leaseOwner: `worker-${process.pid}`,
        ports,
        batch: 8
      });
      for (const { claim, result } of settled) {
        ran += 1;
        const where = `${claim.unitId.padEnd(8)} ${claim.nodeId.padEnd(24)}`;
        if (result.status === "rejected") {
          console.error(`${where} error:`, result.reason);
        } else if (result.value.status === "succeeded") {
          console.log(`${where} -> ${result.value.completion.outcome}`);
        } else {
          console.log(`${where} failed: ${result.value.errorCode}`);
        }
      }
    }
    if (ran > 0) continue;
    if (untilIdle) break;
    await sleep(1_000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}
```

`withApprovalReviewPorts` matters: it wraps your ports so that the reviewer
sees the node's input and output together, and so that a rework round
receives the reviewer's notes. `codeNodePortByNode` sends each code node's
turn to its own function; `compose-reply` and `compose-reply::rework` share
one. `real-model.mjs` only comes into play in step 11.

Run it until nothing is left to do:

```sh
node --env-file=.env worker.mjs --until-idle
```

```
worker: principals local-model, cloud-model, worker
u1       is-question              -> yes
u2       is-question              -> yes
u3       is-question              -> unsure
u4       is-question              -> no
u5       is-question              -> yes
u1       draft-answer::approval   -> approved
u2       draft-answer::approval   -> denied
u5       draft-answer::approval   -> approved
u1       draft-answer             -> drafted
u5       draft-answer             -> drafted
u5       compose-reply            -> composed
u1       compose-reply            -> composed
```

Lines from the same batch may come out in a different order on your machine.
In real use you would leave `node --env-file=.env worker.mjs` running in a
second terminal (Ctrl-C stops it): it polls every second, and each admit or
decision below moves on by itself.

Watch again:

```sh
docker exec -i -e PGPASSWORD=watcher first-switchyard-db \
  psql -h 127.0.0.1 -U watcher -d postgres < watch.sql
```

```
== Where every unit is waiting (position 1 = next in that node's queue)
        node_id         | unit_id | status | position | node_kind | principal_id 
------------------------+---------+--------+----------+-----------+--------------
 compose-reply::review  | u1      | queued |        1 | human     | console
 compose-reply::review  | u5      | queued |        2 | human     | console
 is-question.escalate-1 | u3      | queued |        1 | human     | console
(3 rows)

== The journey of each unit: every node it passed through, in order
 unit_id | seq |        node_id         | status  | outcome  | decided_by | attempts 
---------+-----+------------------------+---------+----------+------------+----------
 u1      |   1 | is-question            | settled | yes      |            |        1
 u1      |   6 | draft-answer::approval | settled | approved |            |        1
 u1      |  10 | draft-answer           | settled | drafted  |            |        1
 u1      |  13 | compose-reply          | settled | composed |            |        1
 u1      |  14 | compose-reply::review  | queued  |          |            |        0
 u2      |   2 | is-question            | settled | yes      |            |        1
 u2      |   7 | draft-answer::approval | settled | denied   |            |        1
 u3      |   3 | is-question            | settled | unsure   |            |        1
 u3      |   9 | is-question.escalate-1 | queued  |          |            |        0
 u4      |   4 | is-question            | settled | no       |            |        1
 u5      |   5 | is-question            | settled | yes      |            |        1
 u5      |   8 | draft-answer::approval | settled | approved |            |        1
 u5      |  11 | draft-answer           | settled | drafted  |            |        1
 u5      |  12 | compose-reply          | settled | composed |            |        1
 u5      |  15 | compose-reply::review  | queued  |          |            |        0
(15 rows)

== Each unit's state and its last step
 unit_id |    state    |            last_step             
---------+-------------+----------------------------------
 u1      | in progress | compose-reply::review -> queued
 u2      | finished    | draft-answer::approval -> denied
 u3      | in progress | is-question.escalate-1 -> queued
 u4      | finished    | is-question -> no
 u5      | in progress | compose-reply::review -> queued
(5 rows)

== Decisions people made
 unit_id | node_id | outcome | actor_id | settled_at 
---------+---------+---------+----------+------------
(0 rows)

== Replies a person accepted
 unit_id | reply 
---------+-------
(0 rows)
```

Your `seq` numbers may differ. What happened to each unit:

- **u1, u5**: a question, cleared by the PII screen, drafted, composed. Both
  now wait in the review queue; `position` is their place in it.
- **u2**: a question, but it holds an email address, so the PII screen
  denied it. It never reached the "cloud" model and is finished.
- **u3**: the small model was unsure, so it waits for a person.
- **u4**: not a question; finished at the first node.

## 9. Be the person

People answer at `human` nodes. switchyard-postgres lists the waiting turns
and records decisions; at approval and review nodes switchyard maps your
answer (`accepted`, `rejected`) to what the node stores
(`accepted:composed`, `rework`, `rejected`) with
`approvalReviewHumanDecision`.

Create `decide.mjs`:

<!-- file: decide.mjs -->
```js
// decide.mjs: list the turns waiting for a person, or answer one.
//   node --env-file=.env decide.mjs
//   node --env-file=.env decide.mjs <unit-id> <answer> ["notes"]
import {
  approvalReviewHumanDecision,
  approvalReviewRole,
  reviewNotes
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { graph } from "./graph.mjs";

const actorId = process.env.ACTOR ?? "alice";

// What a person answers at a node. Approval and review nodes store other
// outcomes (e.g. "accepted:composed"); approvalReviewHumanDecision maps them.
function answersFor(turn) {
  const role = approvalReviewRole(graph, turn.nodeId);
  if (role?.role === "approval") return ["approved", "denied"];
  if (role?.role === "review") return ["accepted", "rejected"];
  return turn.outcomes;
}

// What the person is looking at: the text, or the reply under review.
function subjectOf(turn) {
  const payload = turn.inputArtifact.payload;
  if (turn.inputArtifact.contractId === "switchyard.review-request.v1") {
    return `round ${payload.round} of ${payload.maxRounds}:\n${payload.output.payload.body}`;
  }
  return payload.text;
}

const [unitId, answer, notes] = process.argv.slice(2);
const { pool, humanDecisions } = openStores();
try {
  const pending = await humanDecisions.listPending({ limit: 1_000 });
  if (unitId === undefined) {
    if (pending.length === 0) console.log("nothing is waiting for a person");
    for (const turn of pending) {
      console.log(`${turn.unitId} at ${turn.nodeId}, answers: ${answersFor(turn).join(" | ")}`);
      console.log(`  ${subjectOf(turn).replaceAll("\n", "\n  ")}`);
    }
  } else {
    const turn = pending.find((candidate) => candidate.unitId === unitId);
    if (turn === undefined) throw new Error(`unit ${unitId} is not waiting for a person`);
    if (turn.graph.digest !== graph.graphDigest) {
      throw new Error(`unit ${unitId} runs another version of the graph`);
    }
    // Shape the answer for this node, then record it. The engine checks it
    // against the node's outcomes and routes the unit on.
    const decision = approvalReviewHumanDecision(graph, {
      queued: turn,
      outcome: answer,
      ...(notes === undefined ? {} : { outputArtifact: reviewNotes(notes) }),
      actor: { actorId }
    });
    await humanDecisions.record({
      queueId: turn.queueId,
      outcome: decision.outcome,
      ...(decision.outputArtifact === undefined ? {} : { outputArtifact: decision.outputArtifact }),
      actorId
    });
    console.log(`${unitId} at ${turn.nodeId}: recorded ${decision.outcome}`);
  }
} finally {
  await pool.end();
}
```

See who is waiting:

```sh
node --env-file=.env decide.mjs
```

```
u3 at is-question.escalate-1, answers: no | yes
  I need to talk to someone about my order
u1 at compose-reply::review, answers: accepted | rejected
  round 1 of 2:
  Hello,
  
  Thanks for asking. (echo) What are your opening hours?
  
  -- The team
u5 at compose-reply::review, answers: accepted | rejected
  round 1 of 2:
  Hello,
  
  Thanks for asking. (echo) Do you ship to Canada?
  
  -- The team
```

Answer. u3 is a question after all; u1's reply needs one more line (the
third argument is the note to the author); u5's reply is fine:

```sh
node --env-file=.env decide.mjs u3 yes
node --env-file=.env decide.mjs u1 rejected "Say that we open at 9."
node --env-file=.env decide.mjs u5 accepted
```

```
u3 at is-question.escalate-1: recorded yes
u1 at compose-reply::review: recorded rework
u5 at compose-reply::review: recorded accepted:composed
```

A first rejection is stored as `rework`: `compose-reply` runs again, at
`compose-reply::rework`, with your note. Run the worker:

```sh
node --env-file=.env worker.mjs --until-idle
```

```
worker: principals local-model, cloud-model, worker
u3       draft-answer::approval   -> approved
u3       draft-answer             -> drafted
u1       compose-reply::rework    -> composed
u3       compose-reply            -> composed
```

```sh
node --env-file=.env decide.mjs
```

```
u1 at compose-reply::review, answers: accepted | rejected
  round 2 of 2:
  Hello,
  
  Thanks for asking. (echo) What are your opening hours?
  
  (Revised after review: Say that we open at 9.)
  
  -- The team
u3 at compose-reply::review, answers: accepted | rejected
  round 1 of 2:
  Hello,
  
  Thanks for asking. (echo) I need to talk to someone about my order
  
  -- The team
```

Accept u1's revised reply. Reject u3's reply, then reject its rework too.
The second rejection is the last one allowed (`maxRounds: 2`), so it ends the
unit (`onReject: "terminal"`):

```sh
node --env-file=.env decide.mjs u1 accepted
node --env-file=.env decide.mjs u3 rejected "Too vague."
node --env-file=.env worker.mjs --until-idle
node --env-file=.env decide.mjs u3 rejected "Still too vague."
node --env-file=.env decide.mjs
```

```
u1 at compose-reply::review: recorded accepted:composed
u3 at compose-reply::review: recorded rework
worker: principals local-model, cloud-model, worker
u3       compose-reply::rework    -> composed
u3 at compose-reply::review: recorded rejected
nothing is waiting for a person
```

## 10. The end state

```sh
docker exec -i -e PGPASSWORD=watcher first-switchyard-db \
  psql -h 127.0.0.1 -U watcher -d postgres < watch.sql
```

```
== Where every unit is waiting (position 1 = next in that node's queue)
 node_id | unit_id | status | position | node_kind | principal_id 
---------+---------+--------+----------+-----------+--------------
(0 rows)

== The journey of each unit: every node it passed through, in order
 unit_id | seq |        node_id         | status  |      outcome      | decided_by | attempts 
---------+-----+------------------------+---------+-------------------+------------+----------
 u1      |   1 | is-question            | settled | yes               |            |        1
 u1      |   6 | draft-answer::approval | settled | approved          |            |        1
 u1      |  10 | draft-answer           | settled | drafted           |            |        1
 u1      |  13 | compose-reply          | settled | composed          |            |        1
 u1      |  14 | compose-reply::review  | settled | rework            | alice      |        1
 u1      |  17 | compose-reply::rework  | settled | composed          |            |        1
 u1      |  20 | compose-reply::review  | settled | accepted:composed | alice      |        1
 u2      |   2 | is-question            | settled | yes               |            |        1
 u2      |   7 | draft-answer::approval | settled | denied            |            |        1
 u3      |   3 | is-question            | settled | unsure            |            |        1
 u3      |   9 | is-question.escalate-1 | settled | yes               | alice      |        1
 u3      |  16 | draft-answer::approval | settled | approved          |            |        1
 u3      |  18 | draft-answer           | settled | drafted           |            |        1
 u3      |  19 | compose-reply          | settled | composed          |            |        1
 u3      |  21 | compose-reply::review  | settled | rework            | alice      |        1
 u3      |  22 | compose-reply::rework  | settled | composed          |            |        1
 u3      |  23 | compose-reply::review  | settled | rejected          | alice      |        1
 u4      |   4 | is-question            | settled | no                |            |        1
 u5      |   5 | is-question            | settled | yes               |            |        1
 u5      |   8 | draft-answer::approval | settled | approved          |            |        1
 u5      |  11 | draft-answer           | settled | drafted           |            |        1
 u5      |  12 | compose-reply          | settled | composed          |            |        1
 u5      |  15 | compose-reply::review  | settled | accepted:composed | alice      |        1
(23 rows)

== Each unit's state and its last step
 unit_id |  state   |                 last_step                  
---------+----------+--------------------------------------------
 u1      | finished | compose-reply::review -> accepted:composed
 u2      | finished | draft-answer::approval -> denied
 u3      | finished | compose-reply::review -> rejected
 u4      | finished | is-question -> no
 u5      | finished | compose-reply::review -> accepted:composed
(5 rows)

== Decisions people made
 unit_id |        node_id         |      outcome      | actor_id |         settled_at         
---------+------------------------+-------------------+----------+----------------------------
 u3      | is-question.escalate-1 | yes               | alice    | 2026-09-30 05:39:01.447+00
 u1      | compose-reply::review  | rework            | alice    | 2026-09-30 05:39:02.18+00
 u5      | compose-reply::review  | accepted:composed | alice    | 2026-09-30 05:39:02.974+00
 u1      | compose-reply::review  | accepted:composed | alice    | 2026-09-30 05:39:06.966+00
 u3      | compose-reply::review  | rework            | alice    | 2026-09-30 05:39:07.869+00
 u3      | compose-reply::review  | rejected          | alice    | 2026-09-30 05:39:10.055+00
(6 rows)

== Replies a person accepted
 unit_id |                         reply                          
---------+--------------------------------------------------------
 u5      | Hello,                                                +
         |                                                       +
         | Thanks for asking. (echo) Do you ship to Canada?      +
         |                                                       +
         | -- The team
 u1      | Hello,                                                +
         |                                                       +
         | Thanks for asking. (echo) What are your opening hours?+
         |                                                       +
         | (Revised after review: Say that we open at 9.)        +
         |                                                       +
         | -- The team
(2 rows)
```

Every unit is finished, each with its whole journey kept: which nodes it
passed, with which outcome, who decided, and the replies people accepted.
`settled_at` and `seq` differ from run to run.

## 11. Optional: a real model

The fake model stands where a real one goes. Any OpenAI-compatible server
works (llama-swap, llama.cpp's server, vLLM, Ollama, a hosted API).
`real-model.mjs` is the same port, asking the server one question per node
and reporting the tokens it used:

<!-- file: real-model.mjs -->
```js
// real-model.mjs: the same model port, backed by an OpenAI-compatible server
// (llama-swap, llama.cpp, vLLM, Ollama, ...). worker.mjs uses it when
// MODEL_BASE_URL is set, e.g. MODEL_BASE_URL=http://127.0.0.1:8080/v1
import { ExecutionFailureError, createArtifactEnvelope } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

// Which server-side model each binding runs on.
const MODELS = {
  "small-local": process.env.SMALL_MODEL ?? "qwen2.5-7b",
  "big-cloud": process.env.BIG_MODEL ?? process.env.SMALL_MODEL ?? "qwen2.5-7b"
};

const YES_NO = "Answer with exactly one word: yes, no, or unsure.";

async function chat(model, system, user, signal) {
  let response;
  try {
    response = await fetch(`${process.env.MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal
    });
  } catch (error) {
    // Retryable: the turn is tried again, up to the node's maxAttempts.
    throw new ExecutionFailureError("model_unreachable", true, error);
  }
  if (!response.ok) throw new ExecutionFailureError(`model_http_${response.status}`, true);
  const body = await response.json();
  const tokensIn = body.usage?.prompt_tokens ?? 0;
  const tokensOut = body.usage?.completion_tokens ?? 0;
  return {
    text: body.choices[0].message.content.trim(),
    receipt: {
      schemaVersion: "usage-receipt.v1",
      trust: "provider_reported",
      observedInputTokens: tokensIn,
      observedOutputTokens: tokensOut,
      chargedTokens: tokensIn + tokensOut,
      observedCostMicroUsd: null,
      chargedCostMicroUsd: 0,
      durationMs: 0
    }
  };
}

const word = (text) => text.toLowerCase().match(/\b(yes|no|unsure)\b/)?.[1] ?? "unsure";

export const realModel = {
  async invoke(input, binding, context) {
    const model = MODELS[binding.bindingId];
    const started = Date.now();
    let outcome;
    let outputArtifact;
    let receipt;
    if (context.nodeId === "is-question") {
      const reply = await chat(model, YES_NO,
        `Is this message a question that a support team should answer?\n\n${input.text}`, context.signal);
      outcome = word(reply.text);
      receipt = reply.receipt;
    } else if (context.nodeId === "draft-answer::approval") {
      const reply = await chat(model, YES_NO,
        `Does this text contain personal data (names, email addresses, phone numbers, addresses, account numbers)?\n\n${input.text}`,
        context.signal);
      // Only a clear "no" lets the text go to the cloud model.
      outcome = word(reply.text) === "no" ? "approved" : "denied";
      receipt = reply.receipt;
    } else if (context.nodeId === "draft-answer") {
      const reply = await chat(model, "You answer customer messages in two or three friendly sentences.",
        input.text, context.signal);
      outcome = "drafted";
      outputArtifact = createArtifactEnvelope(DRAFT, { question: input.text, answer: reply.text });
      receipt = reply.receipt;
    } else {
      throw new ExecutionFailureError("no_prompt_for_node", false);
    }
    receipt.durationMs = Date.now() - started;
    return { outcome, ...(outputArtifact ? { outputArtifact } : {}), usage: [receipt] };
  }
};
```

`worker.mjs` uses it when `MODEL_BASE_URL` is set. With a llama-swap on this
machine that serves `qwen2.5-7b`:

```sh
node --env-file=.env admit.mjs r1 "What are your opening hours on Sunday?"
MODEL_BASE_URL=http://127.0.0.1:8080/v1 SMALL_MODEL=qwen2.5-7b node --env-file=.env worker.mjs --until-idle
```

`BIG_MODEL` picks the model for `draft-answer`. The graph did not change: a
binding in `graph.mjs` names a model by id and digest, and the port decides
how to reach it. If the server is down or answers with an error, the turn is
retried (`maxAttempts: 3`) and then fails; `watch.sql` shows it as `failed`
with the error code.

(This adapter was checked against a stub OpenAI-compatible server; the
author's llama-swap could not load a model at the time.)

## What just happened

- **Every node is a node.** Each node has its own durable queue in Postgres.
  A unit's position is always "queued, leased or settled at node N". A worker
  claims a batch of units waiting at one node, as that node's principal, runs
  them, and settles each turn in one transaction: the outcome, the unit's
  journey, and the queue entries of the next nodes. Your code never picks the
  next node; the edges do.
- **Approval and review compile to nodes.** `approval` and `review` are
  settings that `createGraphDefinition` turns into ordinary nodes and edges
  (`::approval`, `::review`, `::rework`), sealed into the graph's digest. So
  they queue, retry and show up in SQL like anything else, and a person and a
  model are interchangeable as approver or reviewer: change `by`.
- **State lives in Postgres.** The scripts keep nothing. Stop the worker at
  any point and start it again: turns resume where they were. Evidence is
  append-only; the runtime role can only call the store routines; the reader
  role can only read.
- **Small models answer yes/no.** A small model is most reliable on one
  narrow question when it is allowed to say it does not know.
  `binaryQuestion` gives it exactly that, and sends `unsure` to someone who
  can decide (a bigger model, a person, or both in order).
- **The graph is sealed.** Change a node, an edge or a model binding and the
  digest changes. Publish that as a new graph version; units already running
  finish on the version they were admitted to.

Where to go next: [the approval and review design](DESIGN-APPROVAL-REVIEW.md),
the [README](../README.md) for joins, declared outputs and the other helpers,
and the [switchyard-postgres README](https://github.com/scshafe/switchyard-postgres#readme)
for the schema and operating notes.

## With switchyard 2.3.0

2.3.0 (not published yet) adds the three helpers this guide had to write
itself. With it, the model's rules in `models.mjs` become a table, and the
usage receipt is added for you (`fakeModelPort`; `DRAFT` and
`PERSONAL_DATA` as before):

```js
import { createArtifactEnvelope, fakeModelPort } from "@scshafe/switchyard";

export const fakeModel = fakeModelPort({
  "is-question": ({ text }) =>
    text.trim().endsWith("?") ? "yes" : /unsubscribe|buy now/i.test(text) ? "no" : "unsure",
  "draft-answer::approval": ({ text }) => (PERSONAL_DATA.test(text) ? "denied" : "approved"),
  "draft-answer": ({ text }) => ({
    outcome: "drafted",
    outputArtifact: createArtifactEnvelope(DRAFT, { question: text, answer: `Thanks for asking. (echo) ${text}` })
  })
});
```

The worker loop in `worker.mjs` becomes one call (`runWorker` finds the
principals itself, sleeps when idle, stops on the signal):

```js
const result = await runWorker({
  store: unitStore,
  ports,
  graphs: [graph],
  leaseOwner: `worker-${process.pid}`,
  untilIdle: process.argv.includes("--until-idle"),
  signal: stop.signal,
  onSettled: ({ claim, result }) => { /* print one line, as before */ }
});
```

And `answersFor` in `decide.mjs` becomes `humanNodeAnswers(graph, turn.nodeId)`.

## Troubleshooting

These are the errors met while writing this guide.

- **`ERR_PNPM_FETCH_401 ... Unauthorized`** or **`No authorization header
  was set for the request`** from `pnpm view` or `pnpm add`: pnpm has no
  valid token. Check the `//npm.pkg.github.com/:_authToken=` line in
  `~/.npmrc` (step 1), that the token is a classic one with `read:packages`,
  and that it has not expired.
- **`ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@scshafe%2Fswitchyard`**:
  pnpm asked the public registry. The project `.npmrc` with
  `@scshafe:registry=https://npm.pkg.github.com` is missing or you are in
  another directory.
- **`Cannot find package 'pg' imported from .../db.mjs`**: `pg` is not a
  direct dependency. `pnpm add --save-exact pg@8.23.0`.
- **`Bind for 127.0.0.1:5432 failed: port is already allocated`**: another
  PostgreSQL uses the port. Start the container with
  `-p 127.0.0.1:5433:5432`, and use `5433` in the `migrate` URL and in
  `.env`.
- **`Conflict. The container name "/first-switchyard-db" is already in use`**:
  a container from an earlier try exists. `docker rm -f first-switchyard-db`
  and start again from step 3 (its data goes with it).
- **`connect ECONNREFUSED 127.0.0.1:5432`** or **`the database system is
  starting up`**: PostgreSQL is not ready yet; run the `until ... pg_isready`
  line.
- **`permission denied for table schema_migrations`**: something called
  `assertSchemaCurrent` from switchyard-postgres as the `app` role. In 0.1.1
  that check needs a role that can read the schema's tables (the owner or
  `watcher`), which the runtime role cannot. This guide does not call it;
  `migrate` already reports the version.
- **`TurnEvidenceConflictError: admitUnit: unit u1 conflicts with immutable
  admission ...`**: that unit id is taken; admissions are immutable. Use a
  new id.
- **`unit u3 is not waiting for a person`** from `decide.mjs`: nothing is
  pending for that unit. Run `node --env-file=.env decide.mjs` to see what
  is, or run the worker first.
- **`NodeTurnCompletionValidationError: ... returned undeclared outcome
  "bogus"`** from `decide.mjs`: answer with one of the answers the list
  shows.
- **A turn prints `failed: immutable_stage_contract_rejected`** at
  `compose-reply` or `draft-answer`: the ports were not wrapped with
  `withApprovalReviewPorts`, or a body returned an artifact with the wrong
  contract (e.g. `compose-reply` must return a `reply.v1`).
- **`model node ... must return exactly one usage receipt`**: your own model
  port returned no `usage`, or more than one receipt.
- **`Unsupported engine`** from pnpm, or syntax errors from Node: use Node
  22.22+ or 24.18+.
- **`EACCES`** from `corepack enable pnpm` or `npm install -g pnpm@10`: your
  Node is installed system-wide. Put the pnpm shim in your own directory
  instead: `corepack enable --install-directory ~/.local/bin pnpm` (with
  `~/.local/bin` on your `PATH`).

## Clean up

```sh
docker rm -f first-switchyard-db
cd .. && rm -rf first-switchyard
```

Keep your `~/.npmrc` token for the next project, or delete the line and
revoke the token on GitHub.
