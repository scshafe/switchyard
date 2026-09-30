# Your first switchyard

This guide takes you from an empty directory to watching units move through a
small switchyard graph whose state lives in PostgreSQL. It takes about twenty
minutes. You need no model server: the models are a few lines of fake,
deterministic code, and a later step shows where a real one plugs in.

Everything you type is in this guide, in order. The finished project is in
[`docs/first-graph-example/`](https://github.com/scshafe/switchyard/tree/main/docs/first-graph-example),
byte for byte the files below. Links to other switchyard files go to the
GitHub repository `scshafe/switchyard`, which is private: opening them needs
the same access as installing the packages (see
[Prerequisites](#prerequisites)).

The guide uses `@scshafe/switchyard` **2.3.0** and
`@scshafe/switchyard-postgres` **0.2.0**. On switchyard 2.2.0 the helpers
`runWorker`, `fakeModelPort`, `latestReviewNotes` and the usage-receipt
helpers do not exist yet;
[the 2.2.0 edition of this guide](https://github.com/scshafe/switchyard/blob/ef32068e01d993487a2c7757ab0e68b198f2668b/docs/FIRST-GRAPH.md)
writes them by hand. switchyard-postgres 0.1.1 has no `recordAnswer`, no
`unit_status`, `unit_positions` or `unit_outputs` views, and no
`connectionString` option;
[the 0.1.1 edition of this guide](https://github.com/scshafe/switchyard/blob/02ae363fca156b72d5fa0146f31f8144da301b33/docs/FIRST-GRAPH.md)
does without them.

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
- **Read access to the `@scshafe` packages.** They are private packages on
  GitHub Packages, so installing them needs two things:
  - a **GitHub account that can read both packages**,
    `@scshafe/switchyard` and `@scshafe/switchyard-postgres`. Ask the
    maintainer (scshafe) to give your account read access to them, and to
    the repositories `scshafe/switchyard` and `scshafe/switchyard-postgres`
    if you want to open this guide's links;
  - a **classic personal access token** of that account with **only the
    `read:packages` scope**. Step 1 creates it.

## 1. Let pnpm read `@scshafe` packages

GitHub Packages asks for a token even to download a package, and its npm
registry accepts only **classic** tokens, not fine-grained ones. The token
only needs to read packages, so give it nothing else.

1. On GitHub, signed in as the account with access, open **Settings →
   Developer settings → Personal access tokens → Tokens (classic) → Generate
   new token (classic)** (<https://github.com/settings/tokens/new>).
2. Give it a name (e.g. `read scshafe packages`), an expiry, and tick
   **only `read:packages`**. Generate it and copy the `ghp_...` value; GitHub
   shows it once.
3. Put it in your **user-level** npm config, `~/.npmrc`, readable only by
   you, and never in a project (a project file gets committed):

   ```sh
   touch ~/.npmrc && chmod 600 ~/.npmrc
   ${EDITOR:-nano} ~/.npmrc
   ```

   Add this line, with your token in place of `ghp_YOUR_TOKEN`, and save:

   ```ini
   //npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN
   ```

   The line says "send this token to `npm.pkg.github.com`", and nowhere
   else. pnpm reads `~/.npmrc` in every project.

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

Create `.npmrc` in the project. It tells pnpm that `@scshafe/*` packages
come from GitHub Packages. It holds no credential, so it is safe to commit:

<!-- file: .npmrc -->
```ini
@scshafe:registry=https://npm.pkg.github.com
```

Without this line pnpm asks the public npm registry for `@scshafe/*` and gets
a 404. You could put the line in `~/.npmrc` instead, next to the token, and
if yours already has it, the project file changes nothing for you. Keep it
anyway: it travels with the project, so a clone, a teammate or a CI job
installs from the right registry with only a token of its own.

Check that pnpm can see the packages:

```sh
pnpm view @scshafe/switchyard@2.3.0 version
```

```
2.3.0
```

If this fails, see [Troubleshooting](#troubleshooting). Now install the
engine and the Postgres stores:

```sh
pnpm add --save-exact @scshafe/switchyard@2.3.0 @scshafe/switchyard-postgres@0.2.0
```

The progress lines vary; the output ends with:

```
dependencies:
+ @scshafe/switchyard 2.3.0
+ @scshafe/switchyard-postgres 0.2.0
```

`pg`, the PostgreSQL client, comes in with `@scshafe/switchyard-postgres`.
The stores open their own connections, so your code never imports it. (If
yours ever does, add it to the project too, with `pnpm add pg`: pnpm lets
code import only the packages its own `package.json` names.)

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
    "@scshafe/switchyard": "2.3.0",
    "@scshafe/switchyard-postgres": "0.2.0"
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
id. The image keeps its data in a Docker volume made for this container;
[Clean up](#clean-up) removes both. Wait until the server accepts
connections (a few seconds):

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
{"schema":"switchyard","applied":[1,2,3,4],"currentVersion":4,"roles":{"runtime":"switchyard_runtime","reader":"switchyard_reader"}}
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

`app` can do nothing but call the store routines. That is enough for
`assertSchemaCurrent({ connectionString })` from switchyard-postgres, which
a long-running service can call at startup to refuse a database whose schema
is older or newer than the library; `migrate` already told you the version
here, so the scripts below do not call it.

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
      // Up to two rounds: a rejection in round 1 sends the draft back to
      // compose-reply::rework with the reviewer's notes; a rejection in
      // round 2, the last one, takes the onReject route and ends the unit.
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
- **Rounds.** `review: { by: person, onReject: "terminal", maxRounds: 2 }`
  gives the reply up to two reviews. `accepted`, in any round, sends the
  reply on (here, to done). `rejected` in round 1 does **not** end the unit:
  `compose-reply` runs again with the reviewer's notes, and its new reply
  comes back for round 2. Only a rejection in the last round (round
  `maxRounds`) takes the `onReject` route, and `"terminal"` means the unit
  ends there, rejected. (`onReject: { to: "some-node" }` sends a final
  rejection to another node instead; `onReject: { retry: true }` keeps
  sending the reply back, with no limit, and takes no `maxRounds`.)
- `approval: { by: piiScreen, onDeny: "terminal" }` has no rounds: the
  approver answers once, and a denial takes the `onDeny` route.
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
`compose-reply::review` (a person answers `accepted` or `rejected`, stored as
`accepted:composed`, `rework` or `rejected`) and `compose-reply::rework`
(the same code runs again with the reviewer's notes, in round 2). They are
ordinary nodes with their own queues.

## 5. The model

Switchyard calls your code through **ports**, one per kind of node. The model
port has one method, `invoke(input, binding, context)`: `input` is the data
the node receives, `binding` says which model the node runs on, and
`context.nodeId` says which node is asking. It returns an outcome, optionally
an artifact to pass on, and exactly one **usage receipt**, a record of what
the call used.

Create `models.mjs`. `fakeModelPort` builds a model port from one rule per
node, so a given message always gets the same answers:

<!-- file: models.mjs -->
```js
// models.mjs: the model port. switchyard calls it for every model turn:
// is-question, draft-answer::approval (the PII screen) and draft-answer.
//
// fakeModelPort answers from rules on the text, so the same input always
// gets the same answer and no model server is needed. It also attaches the
// usage receipt every model turn must return. realModel (in real-model.mjs)
// asks an OpenAI-compatible server instead.
import { createArtifactEnvelope, fakeModelPort } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

const PERSONAL_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\d{3}[\s-]?\d{3}[\s-]?\d{4}/;

// One rule per model node. Each receives the node's input payload (here a
// ticket.v1, { text }) and returns an outcome, or { outcome, outputArtifact }.
export const fakeModel = fakeModelPort({
  // "Is this message a question we should answer?"
  "is-question": ({ text }) => {
    if (text.trim().endsWith("?")) return "yes";
    if (/unsubscribe|buy now/i.test(text)) return "no";
    return "unsure";
  },
  // "May this text go to a cloud model?" An approval answers approved or denied.
  "draft-answer::approval": ({ text }) => (PERSONAL_DATA.test(text) ? "denied" : "approved"),
  // The "cloud" model writes a draft: the outcome plus the draft.v1 it carries on.
  "draft-answer": ({ text }) => ({
    outcome: "drafted",
    outputArtifact: createArtifactEnvelope(DRAFT, {
      question: text,
      answer: `Thanks for asking. (echo) ${text}`
    })
  })
});
```

- `is-question`: a message ending in `?` is a question; one that says "buy
  now" is not; anything else is `unsure`.
- `draft-answer::approval`, the PII screen: an email address or a phone
  number means `denied`, and the text never reaches `draft-answer`.
- `draft-answer`: echoes the question into a draft.

A fake model has no token counts to report, so `fakeModelPort` attaches
`unavailableUsageReceipt()`: trust `unavailable`, charging 1 token and 1
micro-USD. That is the least such a receipt may charge; a receipt without
telemetry may never charge 0, so a missing count never looks free. A real
model that reports its token counts returns a different receipt
([step 11](#11-optional-a-real-model)).

## 6. Connect and admit units

Create `db.mjs`. It builds the three stores switchyard-postgres provides:
`graphStore` (sealed graphs), `unitStore` (units and their turns) and
`humanDecisions` (what people answer). They share one pool of connections,
logged in as the `app` role, and `close()` ends it:

<!-- file: db.mjs -->
```js
// db.mjs: the three Postgres stores, over one connection pool.
import { createPostgresStores } from "@scshafe/switchyard-postgres";

export function openStores() {
  // APP_DATABASE_URL logs in as a member of switchyard_runtime: it can call
  // the store routines and nothing else. The stores open their own pool, and
  // close() ends it.
  return createPostgresStores({
    connectionString: process.env.APP_DATABASE_URL,
    onPoolError: (error) => console.error("idle PostgreSQL client failed", error)
  });
}
```

Create `admit.mjs`. It publishes the graph (publishing the same sealed graph
again changes nothing) and admits one **unit**, a message that travels
through the graph:

<!-- file: admit.mjs -->
```js
// admit.mjs: publish the graph and admit one unit (a message) into it.
//   node --env-file=.env admit.mjs <unit-id> "<text>"
import {
  TurnEvidenceConflictError,
  createArtifactEnvelope,
  graphDefinitionRef
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { TICKET, graph } from "./graph.mjs";

const [unitId, text] = process.argv.slice(2);
if (unitId === undefined || text === undefined) {
  console.error('usage: node --env-file=.env admit.mjs <unit-id> "<text>"');
  process.exit(2);
}

const { graphStore, unitStore, close } = openStores();
try {
  // Publishing the same sealed graph again changes nothing.
  await graphStore.publishGraph(graph);
  const { entryQueue } = await unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope(TICKET, { text }),
    // When the unit entered. Part of its admission, which never changes.
    admittedAt: new Date().toISOString(),
    principalId: "admitter"
  });
  console.log(`admitted ${unitId}: queued at ${entryQueue.nodeId}`);
} catch (error) {
  // A unit id is admitted once. Running this again with the same id makes a
  // new admittedAt (and maybe other text), which conflicts with the stored
  // admission.
  if (!(error instanceof TurnEvidenceConflictError)) throw error;
  console.error(`${unitId} is already admitted; admit the message under a new unit id`);
  process.exitCode = 1;
} finally {
  await close();
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

A unit's admission (its id, graph, message, `admittedAt` and who admitted
it) is evidence and never changes. Run the first line again:

```sh
node --env-file=.env admit.mjs u1 "What are your opening hours?"
```

```
u1 is already admitted; admit the message under a new unit id
```

`admitUnit` treats a second admission of the same id as a replay only when
every field is identical, and then returns `created: false` instead of
queueing the unit twice. That is for a program that retries the very same
admission, for example after a lost connection, with the `admittedAt` it
recorded the first time. This script stamps the time when it runs, so a
second run is a different admission, and the store refuses it
(`TurnEvidenceConflictError`). The script turns that into the message above.
Faking a fixed `admittedAt` to make the replay work would record a false
admission time, so the guide does not.

## 7. Watch from the database

Create `watch.sql`. It reads the views switchyard-postgres provides, all in
the schema `switchyard`:

- `unit_status`: one row per unit, with its `status` and, once nothing is
  left to run, the end it reached (`final_node_id`, `final_outcome`);
- `unit_positions`: one row per unit waiting at a node, with its place in
  that node's queue (`queue_position`, 1 is next);
- `turns`: one row per visit of a unit to a node, with its status
  (`queued`, `leased`, `settled` or `failed`), outcome and attempts;
- `human_decisions`: what people decided, in order;
- `unit_outputs`: every artifact a turn produced, with its `payload` as
  `jsonb`.

<!-- file: watch.sql -->
```sql
-- watch.sql: run as the read-only role (a member of switchyard_reader).

\echo '== Each unit: its status, and the end it reached'
SELECT unit_id, status, final_node_id, final_outcome
FROM switchyard.unit_status
ORDER BY unit_id;

\echo '== Where every unit is waiting (position 1 = next in that node''s queue)'
SELECT node_id, unit_id, state, queue_position AS position, node_kind, principal_id
FROM switchyard.unit_positions
ORDER BY node_id, position;

\echo '== The journey of each unit: every node it passed through, in order'
SELECT unit_id, enqueue_sequence AS seq, node_id, status, outcome,
       actor_id AS decided_by, attempts
FROM switchyard.turns
ORDER BY unit_id, enqueue_sequence;

\echo '== Decisions people made'
SELECT unit_id, node_id, outcome, actor_id, settled_at
FROM switchyard.human_decisions
ORDER BY decision_sequence;

\echo '== Replies a person accepted'
SELECT unit_id, payload ->> 'body' AS reply
FROM switchyard.unit_outputs
WHERE node_id = 'compose-reply::review' AND outcome = 'accepted:composed'
ORDER BY settlement_sequence;
```

Run it as `watcher`, the read-only role, with the `psql` inside the
container:

```sh
docker exec -i -e PGPASSWORD=watcher first-switchyard-db \
  psql -h 127.0.0.1 -U watcher -d postgres < watch.sql
```

```
== Each unit: its status, and the end it reached
 unit_id | status | final_node_id | final_outcome 
---------+--------+---------------+---------------
 u1      | active |               | 
 u2      | active |               | 
 u3      | active |               | 
 u4      | active |               | 
 u5      | active |               | 
(5 rows)

== Where every unit is waiting (position 1 = next in that node's queue)
   node_id   | unit_id | state  | position | node_kind | principal_id 
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

== Decisions people made
 unit_id | node_id | outcome | actor_id | settled_at 
---------+---------+---------+----------+------------
(0 rows)

== Replies a person accepted
 unit_id | reply 
---------+-------
(0 rows)
```

All five units are `active` (they have work queued that is not a person's)
and wait at `is-question`, first come first served.

All five units wait at `is-question`, first come first served.

## 8. Run the worker

The worker claims queued turns and runs them. A turn is claimed by a
**principal**, the identity a node runs as (`local-model`, `cloud-model`,
`worker` in `graph.mjs`), and a claim takes a batch of units waiting at the
same node. `runWorker` asks for each principal in turn, runs the batch
through the ports, reports each turn, and repeats; it sleeps a second when
nothing is queued.

Create `worker.mjs`:

<!-- file: worker.mjs -->
```js
// worker.mjs: the worker. It claims queued turns for every principal that
// runs code or model nodes, runs them through the ports, and repeats.
//   node --env-file=.env worker.mjs               keep polling (Ctrl-C stops)
//   node --env-file=.env worker.mjs --until-idle  stop when nothing is queued
import {
  SWITCHYARD_REWORK_CONTRACT,
  codeNodePortByNode,
  createArtifactEnvelope,
  latestReviewNotes,
  runWorker,
  withApprovalReviewPorts,
  workerPrincipals
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { REPLY, graph } from "./graph.mjs";
import { fakeModel } from "./models.mjs";

// The body of compose-reply. It receives a draft.v1, { question, answer },
// and returns its outcome with the reply.v1 it produced. After a rejected
// review it runs again at compose-reply::rework, whose input is a
// switchyard.rework.v1 record: the original draft.v1 in input.payload, plus
// every rejected round with the reviewer's notes.
async function composeReply(input, context) {
  const rework = context.inputArtifact.contractId === SWITCHYARD_REWORK_CONTRACT;
  const draft = rework ? input.input.payload : input;
  const notes = rework ? latestReviewNotes(input) : undefined;
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
// rounds receive. Without it, reviewed nodes fail closed.
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

function report({ claim, result }) {
  const where = `${claim.unitId.padEnd(8)} ${claim.nodeId.padEnd(24)}`;
  if (result.status === "rejected") {
    console.error(`${where} error:`, result.reason);
  } else if (result.value.status === "succeeded") {
    console.log(`${where} -> ${result.value.completion.outcome}`);
  } else {
    console.log(`${where} failed: ${result.value.errorCode}`);
  }
}

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const { unitStore, close } = openStores();
console.log(`worker: principals ${workerPrincipals([graph]).join(", ")}`);
try {
  await runWorker({
    store: unitStore,
    ports,
    graphs: [graph],
    leaseOwner: `worker-${process.pid}`,
    untilIdle: process.argv.includes("--until-idle"),
    signal: stop.signal,
    onSettled: report
  });
} finally {
  await close();
}
```

`composeReply` is the code of `compose-reply`. Its first run receives the
draft itself; a rework run receives a `switchyard.rework.v1` record that
wraps the draft and the reviewer's notes, so the body checks which contract
it got. [What a node receives and returns](#what-a-node-receives-and-returns)
lists these shapes. `withApprovalReviewPorts` matters: it wraps your ports so
that the reviewer sees the node's input and output together, and so that a
rework round receives the reviewer's notes. `codeNodePortByNode` sends each
code node's turn to its own function; `compose-reply` and
`compose-reply::rework` share one. `real-model.mjs` only comes into play in
step 11.

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
== Each unit: its status, and the end it reached
 unit_id |     status     |     final_node_id      | final_outcome 
---------+----------------+------------------------+---------------
 u1      | awaiting_human |                        | 
 u2      | completed      | draft-answer::approval | denied
 u3      | awaiting_human |                        | 
 u4      | completed      | is-question            | no
 u5      | awaiting_human |                        | 
(5 rows)

== Where every unit is waiting (position 1 = next in that node's queue)
        node_id         | unit_id | state  | position | node_kind | principal_id 
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
 u3      |   8 | is-question.escalate-1 | queued  |          |            |        0
 u4      |   4 | is-question            | settled | no       |            |        1
 u5      |   5 | is-question            | settled | yes      |            |        1
 u5      |   9 | draft-answer::approval | settled | approved |            |        1
 u5      |  11 | draft-answer           | settled | drafted  |            |        1
 u5      |  12 | compose-reply          | settled | composed |            |        1
 u5      |  15 | compose-reply::review  | queued  |          |            |        0
(15 rows)

== Decisions people made
 unit_id | node_id | outcome | actor_id | settled_at 
---------+---------+---------+----------+------------
(0 rows)

== Replies a person accepted
 unit_id | reply 
---------+-------
(0 rows)
```

Your `seq` numbers may differ, and so may the order (and `position`) of
units that settled in the same batch. What happened to each unit:

- **u1, u5**: a question, cleared by the PII screen, drafted, composed. Both
  now wait in the review queue; `position` is their place in it.
- **u2**: a question, but it holds an email address, so the PII screen
  denied it. It never reached the "cloud" model and is finished.
- **u3**: the small model was unsure, so it waits for a person.
- **u4**: not a question; finished at the first node.

`awaiting_human` means everything the unit has open waits for a person.
`completed` means nothing is left to run and the unit reached one of the
graph's ends, whichever one: `final_node_id` and `final_outcome` say which.

## 9. Be the person

People answer at `human` nodes. switchyard-postgres lists the waiting turns
(`listPending`), each with the `answers` a person may give there, and records
what the person answered (`recordAnswer`). `recordAnswer` checks the answer
and turns it into what the node stores: at a review, `accepted` becomes
`accepted:composed`, and `rejected` becomes `rework` (with your notes)
before the last round and `rejected` in it. A wrong answer throws
`InvalidHumanAnswerError`, which lists the right ones, and records nothing.

Create `decide.mjs`:

<!-- file: decide.mjs -->
```js
// decide.mjs: list the turns waiting for a person, or answer one.
//   node --env-file=.env decide.mjs
//   node --env-file=.env decide.mjs <unit-id> <answer> ["notes"]
import { SWITCHYARD_REVIEW_REQUEST_CONTRACT } from "@scshafe/switchyard";
import { InvalidHumanAnswerError } from "@scshafe/switchyard-postgres";

import { openStores } from "./db.mjs";

const actorId = process.env.ACTOR ?? "alice";

// What the person is looking at. A review node receives a
// switchyard.review-request.v1 record: the round, the node's input, and the
// output under review (here a reply.v1, { body }). The other human node here,
// is-question.escalate-1, receives the message itself, a ticket.v1.
function subjectOf(turn) {
  const payload = turn.inputArtifact.payload;
  if (turn.inputArtifact.contractId === SWITCHYARD_REVIEW_REQUEST_CONTRACT) {
    return `round ${payload.round} of ${payload.maxRounds}:\n${payload.output.payload.body}`;
  }
  return payload.text;
}

const [unitId, answer, notes] = process.argv.slice(2);
const { humanDecisions, close } = openStores();
try {
  if (unitId === undefined) {
    const pending = await humanDecisions.listPending({ limit: 1_000 });
    if (pending.length === 0) console.log("nothing is waiting for a person");
    for (const turn of pending) {
      // turn.answers: what a person may answer here, in the node's order.
      console.log(`${turn.unitId} at ${turn.nodeId}, answers: ${turn.answers.join(" | ")}`);
      console.log(`  ${subjectOf(turn).replaceAll("\n", "\n  ")}`);
    }
  } else {
    // In this graph a unit waits for a person at one node at a time.
    const [turn] = await humanDecisions.listPending({ unitId });
    if (turn === undefined) throw new Error(`unit ${unitId} is not waiting for a person`);
    // Record the answer. The store checks it against turn.answers and stores
    // what the node records: at a review, "accepted" as "accepted:composed",
    // "rejected" as "rework" with the notes (or "rejected" in the last
    // round). The engine then settles the turn and routes the unit on.
    const recorded = await humanDecisions.recordAnswer({
      queueId: turn.queueId,
      answer,
      ...(notes === undefined ? {} : { notes }),
      actorId
    });
    console.log(`${unitId} at ${turn.nodeId}: recorded ${recorded.outcome}`);
  }
} catch (error) {
  // A typo, or notes with an answer that takes none. Nothing was recorded.
  if (!(error instanceof InvalidHumanAnswerError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
```

See who is waiting:

```sh
node --env-file=.env decide.mjs
```

```
u3 at is-question.escalate-1, answers: yes | no
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

u1's rejection was in round 1 of 2, so it is stored as `rework`, not as the
end of the unit: `compose-reply` runs again, at `compose-reply::rework`, with
your note. Run the worker:

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
The second rejection is in the last round (`maxRounds: 2`), so it takes the
`onReject` route and ends the unit (`"terminal"`):

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
== Each unit: its status, and the end it reached
 unit_id |  status   |     final_node_id      |   final_outcome   
---------+-----------+------------------------+-------------------
 u1      | completed | compose-reply::review  | accepted:composed
 u2      | completed | draft-answer::approval | denied
 u3      | completed | compose-reply::review  | rejected
 u4      | completed | is-question            | no
 u5      | completed | compose-reply::review  | accepted:composed
(5 rows)

== Where every unit is waiting (position 1 = next in that node's queue)
 node_id | unit_id | state | position | node_kind | principal_id 
---------+---------+-------+----------+-----------+--------------
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
 u3      |   8 | is-question.escalate-1 | settled | yes               | alice      |        1
 u3      |  16 | draft-answer::approval | settled | approved          |            |        1
 u3      |  18 | draft-answer           | settled | drafted           |            |        1
 u3      |  19 | compose-reply          | settled | composed          |            |        1
 u3      |  21 | compose-reply::review  | settled | rework            | alice      |        1
 u3      |  22 | compose-reply::rework  | settled | composed          |            |        1
 u3      |  23 | compose-reply::review  | settled | rejected          | alice      |        1
 u4      |   4 | is-question            | settled | no                |            |        1
 u5      |   5 | is-question            | settled | yes               |            |        1
 u5      |   9 | draft-answer::approval | settled | approved          |            |        1
 u5      |  11 | draft-answer           | settled | drafted           |            |        1
 u5      |  12 | compose-reply          | settled | composed          |            |        1
 u5      |  15 | compose-reply::review  | settled | accepted:composed | alice      |        1
(23 rows)

== Decisions people made
 unit_id |        node_id         |      outcome      | actor_id |         settled_at         
---------+------------------------+-------------------+----------+----------------------------
 u3      | is-question.escalate-1 | yes               | alice    | 2026-09-30 06:26:10.942+00
 u1      | compose-reply::review  | rework            | alice    | 2026-09-30 06:26:11.241+00
 u5      | compose-reply::review  | accepted:composed | alice    | 2026-09-30 06:26:11.546+00
 u1      | compose-reply::review  | accepted:composed | alice    | 2026-09-30 06:26:12.703+00
 u3      | compose-reply::review  | rework            | alice    | 2026-09-30 06:26:13.002+00
 u3      | compose-reply::review  | rejected          | alice    | 2026-09-30 06:26:13.679+00
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

Every unit is `completed`, and `final_outcome` says how each one ended. Its
whole journey is kept: which nodes it passed, with which outcome, who
decided, and the replies people accepted. `settled_at` and `seq` differ from
run to run.

## What a node receives and returns

A reference for writing your own bodies and review screens. Every contract id
below is exported as a constant, and every record shape as a TypeScript type,
from `@scshafe/switchyard`.

**Any body.** A code body is `(input, context)`; a model port is
`invoke(input, binding, context)`. `input` is the **payload** of the turn's
input artifact, already checked: at `is-question` a `ticket.v1`, `{ text }`.
`context.nodeId` names the node and `context.inputArtifact` is
`{ contractId, digest }` (no payload). A body returns
`{ outcome, outputArtifact? }` (type `NodeTurnCompletion`):

- `outcome` is one of the node's outcomes.
- `outputArtifact` is `createArtifactEnvelope(contractId, payload)`, the
  data the outcome carries on. If the node declares `outputs` (like
  `compose-reply`'s `composed: REPLY`), it must be that contract. Leave it
  out and the node's input is carried on unchanged.
- A model port also returns `usage: [receipt]`, exactly one:
  `unavailableUsageReceipt(durationMs)` or `providerReportedUsageReceipt(...)`.

**An approval node** (`X::approval`) receives exactly what `X` would, here
the `ticket.v1`; there is no wrapper. It answers `approved` or `denied`
(`APPROVAL_OUTCOMES`) and returns no artifact: both outcomes carry the input
on, `approved` to `X`.

**A reviewed node's first run** (`X`, here `compose-reply`) receives its own
input (a `draft.v1`) and returns its own outcome and output (a `reply.v1`).
`withApprovalReviewPorts` then wraps that into the review request.

**A review node** (`X::review`) receives a review request,
`SWITCHYARD_REVIEW_REQUEST_CONTRACT` = `"switchyard.review-request.v1"`,
type `ReviewRequestPayload`:

| field | what it is |
|---|---|
| `subject` | `{ nodeId, nodeRef }` of the reviewed node |
| `round` | the round under review, from 1 |
| `maxRounds` | the sealed limit (`null` with `onReject: { retry: true }`) |
| `input` | the reviewed node's original input, an `EmbeddedArtifact` `{ contractId, digest, payload }`; here the `draft.v1` |
| `outcome` | the reviewed node's outcome this round, e.g. `composed` |
| `output` | what it produced, an `EmbeddedArtifact`; here `output.payload` is the `reply.v1`, `{ body }` |
| `history` | the earlier, rejected rounds, oldest first (`ReviewHistoryEntry`: `{ round, outcome, output, feedback }`) |

A reviewer (person or model) answers `accepted` or `rejected`
(`REVIEWER_OUTCOMES`; for a person, `listPending` gives them as the turn's
`answers`, and `humanNodeAnswers(graph, nodeId)` reads them from the graph),
and may attach notes to a rejection: `recordAnswer`'s `notes`, which it
records as `reviewNotes("...")` (`SWITCHYARD_REVIEW_NOTES_CONTRACT`,
`{ notes }`); a model reviewer returns `reviewNotes("...")` as its
`outputArtifact`. The node stores `accepted:<outcome>` carrying `output` on,
`rework` carrying a rework record, or, in the last round, `rejected`
carrying a `switchyard.review-rejected.v1` record (`ReviewRejectedPayload`)
to the `onReject` route.

**A rework node** (`X::rework`) receives
`SWITCHYARD_REWORK_CONTRACT` = `"switchyard.rework.v1"`, type
`ReworkPayload`: `{ subject, round, maxRounds, input, history }`. `round` is
the round about to run (from 2); `input.payload` is the original input (the
`draft.v1`); `history.at(-1)` is the round just rejected, with the rejected
`output` and the reviewer's `feedback`. `latestReviewNotes(input)` reads the
notes. It returns what `X` returns (a `reply.v1` with `composed`), and
`withApprovalReviewPorts` turns that into the next round's review request.

In JavaScript you can still name the types for your editor, e.g.
`/** @param {import("@scshafe/switchyard").ReworkPayload} rework */`.

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
import {
  ExecutionFailureError,
  createArtifactEnvelope,
  providerReportedUsageReceipt,
  unavailableUsageReceipt
} from "@scshafe/switchyard";

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
  return { text: body.choices[0].message.content.trim(), usage: body.usage };
}

// Every model turn returns exactly one usage receipt. When the server reports
// its token counts, the receipt says so ("provider_reported") and charges
// their sum; a local server costs nothing in dollars, so the charged cost is
// 0 (put a hosted API's price there). When it reports nothing, the receipt is
// "unavailable" and charges the floor, 1 token and 1 micro-USD, so missing
// counts never look free.
function receipt(usage, durationMs) {
  if (Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens)) {
    return providerReportedUsageReceipt({
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      chargedCostMicroUsd: 0,
      durationMs
    });
  }
  return unavailableUsageReceipt(durationMs);
}

const word = (text) => text.toLowerCase().match(/\b(yes|no|unsure)\b/)?.[1] ?? "unsure";

export const realModel = {
  async invoke(input, binding, context) {
    const model = MODELS[binding.bindingId];
    const started = Date.now();
    let reply;
    let completion;
    if (context.nodeId === "is-question") {
      reply = await chat(model, YES_NO,
        `Is this message a question that a support team should answer?\n\n${input.text}`, context.signal);
      completion = { outcome: word(reply.text) };
    } else if (context.nodeId === "draft-answer::approval") {
      reply = await chat(model, YES_NO,
        `Does this text contain personal data (names, email addresses, phone numbers, addresses, account numbers)?\n\n${input.text}`,
        context.signal);
      // Only a clear "no" lets the text go to the cloud model.
      completion = { outcome: word(reply.text) === "no" ? "approved" : "denied" };
    } else if (context.nodeId === "draft-answer") {
      reply = await chat(model, "You answer customer messages in two or three friendly sentences.",
        input.text, context.signal);
      completion = {
        outcome: "drafted",
        outputArtifact: createArtifactEnvelope(DRAFT, { question: input.text, answer: reply.text })
      };
    } else {
      throw new ExecutionFailureError("no_prompt_for_node", false);
    }
    return { ...completion, usage: [receipt(reply.usage, Date.now() - started)] };
  }
};
```

The receipt follows what the server says. If it reports its token counts,
the receipt is `providerReportedUsageReceipt`: trust `provider_reported`,
the observed counts, `chargedTokens` their sum (0 only if the server really
reported 0), and `chargedCostMicroUsd: 0` because a local server costs no
money; put a hosted API's price there. If the server reports no usage, the
receipt is `unavailableUsageReceipt`, charging 1 token and 1 micro-USD like
the fake model. Validation accepts a charge of 0 only on a receipt that
carries observed counts.

`worker.mjs` uses it when `MODEL_BASE_URL` is set. With a llama-swap on this
machine that serves `qwen2.5-7b`:

```sh
node --env-file=.env admit.mjs r1 "What are your opening hours on Sunday?"
MODEL_BASE_URL=http://127.0.0.1:8080/v1 SMALL_MODEL=qwen2.5-7b node --env-file=.env worker.mjs --until-idle
```

`BIG_MODEL` picks the model for `draft-answer`. The graph did not change: a
binding in `graph.mjs` names a model by id and digest, and the port decides
how to reach it. If the server is down or answers with an error, the turn is
retried (`maxAttempts: 3`) and then fails (`failed: model_unreachable`
from the worker). `watch.sql` then shows the unit and that turn as `failed`;
the `error_code` column of `switchyard.turns` says why.

(This adapter was checked against a stub OpenAI-compatible server, with and
without reported usage, and against no server at all; the author's
llama-swap could not load a model at the time.)

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

Where to go next (all in the private repositories):
[the approval and review design](https://github.com/scshafe/switchyard/blob/main/docs/DESIGN-APPROVAL-REVIEW.md),
the [switchyard README](https://github.com/scshafe/switchyard/blob/main/README.md)
for joins, declared outputs and the other helpers, and the
[switchyard-postgres README](https://github.com/scshafe/switchyard-postgres/blob/main/README.md)
for the schema and operating notes.

## Troubleshooting

These are the errors met while writing and testing this guide, plus the
access errors a new reader may meet.

- **`ERR_PNPM_FETCH_401 ... Unauthorized`** or **`No authorization header
  was set for the request`** from `pnpm view` or `pnpm add`: pnpm has no
  valid token. Check the `//npm.pkg.github.com/:_authToken=` line in
  `~/.npmrc` (step 1), that the token is a classic one with `read:packages`,
  and that it has not expired.
- **A 403 (`Forbidden`) or 404 from `npm.pkg.github.com`**: the token is
  accepted but its account cannot read the package. Ask for read access
  ([Prerequisites](#prerequisites)), for the account the token belongs to.
- **`ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@scshafe%2Fswitchyard`**:
  pnpm asked the public registry. The project `.npmrc` with
  `@scshafe:registry=https://npm.pkg.github.com` is missing or you are in
  another directory.
- **`Bind for 127.0.0.1:5432 failed: port is already allocated`**: another
  PostgreSQL uses the port. Start the container with
  `-p 127.0.0.1:5433:5432`, and use `5433` in the `migrate` URL and in
  `.env`.
- **`Conflict. The container name "/first-switchyard-db" is already in use`**:
  a container from an earlier try exists. `docker rm -f -v first-switchyard-db`
  removes it and its data volume; start again from step 3.
- **`connect ECONNREFUSED 127.0.0.1:5432`** or **`the database system is
  starting up`**: PostgreSQL is not ready yet; run the `until ... pg_isready`
  line.
- **`SwitchyardPostgresConfigError: createPostgresStores requires a pool or
  a connectionString`**: `APP_DATABASE_URL` is not set. Run the scripts as
  `node --env-file=.env ...`, from the project directory, with the `.env`
  of step 3.
- **`u1 is already admitted; admit the message under a new unit id`** from
  `admit.mjs`: that unit id is taken (step 6). In your own code the error is
  `TurnEvidenceConflictError: admitUnit: unit u1 conflicts with immutable
  admission ... (differs in admittedAt: stored ..., requested ...)`. Its
  stack names `MemoryUnitStore` even though the unit lives in Postgres:
  switchyard-postgres loads the unit's rows, runs the operation through
  switchyard's in-memory store logic, and writes the result back in the same
  transaction, so the engine's checks and messages are the same for every
  store.
- **`unit u3 is not waiting for a person`** from `decide.mjs`: nothing is
  pending for that unit. Run `node --env-file=.env decide.mjs` to see what
  is, or run the worker first.
- **`"accept" is not an answer here (node compose-reply::review of unit u1;
  valid answers: accepted, rejected)`** from `decide.mjs`: a typo. Nothing
  was recorded; answer with one of the answers it names (the list
  `decide.mjs` prints shows them too). **`notes go only with "rejected"`**
  means a note came with another answer: only a rejection carries notes.
- **`... returned undeclared outcome "bogus" (its outcomes: ...)`** from a
  worker turn: your body or model port returned an outcome the node does not
  have. The message lists the ones it has.
- **A turn prints `failed: immutable_stage_contract_rejected`** at
  `compose-reply` or `draft-answer`: the ports were not wrapped with
  `withApprovalReviewPorts`, or a body returned an artifact with the wrong
  contract (e.g. `compose-reply` must return a `reply.v1`).
- **`model node ... must return exactly one usage receipt`**: your own model
  port returned no `usage`, or more than one receipt.
- **`usage receipt: unavailable receipt must charge at least 1 token`** (or
  `micro-USD`): a receipt without observed counts charged 0. Use
  `unavailableUsageReceipt()`.
- **`Unsupported engine`** from pnpm, or syntax errors from Node: use Node
  22.22+ or 24.18+.
- **`EACCES`** from `corepack enable pnpm` or `npm install -g pnpm@10`: your
  Node is installed system-wide. Put the pnpm shim in your own directory
  instead: `corepack enable --install-directory ~/.local/bin pnpm` (with
  `~/.local/bin` on your `PATH`).

## Clean up

Remove the container **and its data volume** (`-v`; without it the volume
stays behind, unnamed, in `docker volume ls`), then the project:

```sh
docker rm -f -v first-switchyard-db
cd .. && rm -rf first-switchyard
```

`docker image rm postgres:18` also frees the image, if nothing else uses it.
Keep your `~/.npmrc` token for the next project, or delete the line and
revoke the token on GitHub.
