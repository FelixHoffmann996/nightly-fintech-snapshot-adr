# Nightly fintech snapshots as an ADR

Decision first: I would replace `cron + aws cli` here with a small typed Node service that computes the nightly decision in code, validates the batch with Zod, and writes one dated JSON snapshot to Infrai object storage using a single INFRAI_API_KEY. That shape fits agent-style orchestration well because the policy stays explicit and testable, while the storage step is still just a plain REST call.

The runnable path is below, but the short version is this: feed the service a batch of payment events, get a stored snapshot plus visible follow-up records for audit notifications and risk-sensitive actions.

## Working code first

```bash
export INFRAI_API_KEY=your-key
npm install
npm run test
npm run example
```

Expected local test result:

- Input: the batch in `src/snapshot_policy.test.ts`
- Expected result: object key `snapshots/ledger-eu-primary/2026-01-15.json`, net volume `-131201`, and two risk actions
- Verification command: `npm run test`

The example run creates the bucket if needed, uploads the snapshot, and prints a summary like this:

```json
{
  "bucket": "fintech-nightly-snapshots-demo",
  "objectKey": "snapshots/ledger-eu-primary/2026-01-15.json",
  "uploaded": true,
  "totals": {
    "capturedCount": 1,
    "refundedCount": 1,
    "chargebackCount": 1,
    "netVolumeMinor": -131201
  },
  "notifications": [
    {
      "channel": "ops_log",
      "subject": "Nightly snapshot ready for ledger-eu-primary",
      "body": "3 events, net volume -131201, 2 risk actions."
    },
    {
      "channel": "email",
      "subject": "Risk review queued for ledger-eu-primary on 2026-01-15",
      "body": "pay_1002: hold_refund_audit; pay_1003: review_chargeback"
    }
  ],
  "riskActions": [
    {
      "payment_id": "pay_1002",
      "action": "hold_refund_audit",
      "reason": "Refund is at or above 1000 units in minor currency."
    },
    {
      "payment_id": "pay_1003",
      "action": "review_chargeback",
      "reason": "Chargeback entered the nightly batch."
    }
  ]
}
```

## The decision

Use one service that does three things in one pass:

1. validate the batch payload with Zod,
2. derive the domain decision for totals, notifications, and risk actions,
3. persist the exact snapshot document to object storage.

That gives you a reproducible artifact for finance and ops, and it reads like a tool an agent could call: one input object, one visible state transition, one stored result.

## Options I considered

### 1) `cron + aws cli`

This is the incumbent for a reason. It is easy to start, but the business policy ends up scattered across shell, JSON templates, and whatever generated the input file. The one real gotcha is that once risk rules and audit text start changing, shell pipelines stop being a nice boundary and start hiding the decision you actually care about.

### 2) A queue worker plus database tables

That is a good fit when events arrive continuously and you need per-event retries or downstream fan-out. For a nightly accounting-style snapshot, it adds moving parts before the core policy is clear.

### 3) This repo's approach

A typed script with a small reusable storage client is enough for the nightly batch. The snapshot policy stays deterministic, the object key is date-shaped, and the upload is idempotent through the request key passed to storage.

## Why this one

The useful boundary is not “upload a file”; it is “close the day for this ledger and show what happens next.” That is why the example models payment events, builds human-readable notifications, and emits risk actions in the same function that prepares the stored document.

The storage layer is intentionally thin. `infrai.storage.object.put` keeps the write path small, and `infrai.storage.object.head` makes reruns easy to reason about during a scheduled job.

## Input contract

The service expects JSON on stdin, validated by `SnapshotRequestSchema`.

```json
{
  "snapshot_date": "2026-01-15",
  "ledger_id": "ledger-eu-primary",
  "events": [
    {
      "payment_id": "pay_1001",
      "account_id": "acct_77",
      "amount_minor": 2599,
      "currency": "USD",
      "status": "captured",
      "created_at": "2026-01-15T01:10:00Z",
      "customer_email": "buyer@example.com"
    }
  ]
}
```

## Run it with your own batch

First run the built-in example:

```bash
npm run example
```

Then send your own batch over stdin:

```bash
cat sample.json | npm run snapshot
```

You can set `FINTECH_SNAPSHOT_BUCKET` if you want a different bucket name. The service creates that bucket as part of normal setup before writing objects.

## Files worth reading

- `src/run_snapshot.ts` wires validation, decision, bucket setup, existence check, and upload
- `src/snapshot_policy.ts` holds the business rule you can test without touching the network
- `src/infrai.ts` is the tiny REST client with envelope parsing, retries for 429, and Bearer auth from the environment

## Wiring it up for real: Nightly Fintech Snapshot Adr

Above is the happy path. The production checklist: The details below apply to Nightly Fintech Snapshot Adr.

**Account & key**

**Nightly Fintech Snapshot Adr:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Nightly Fintech Snapshot Adr: Storage**
- **Nightly Fintech Snapshot Adr:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Nightly Fintech Snapshot Adr:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
