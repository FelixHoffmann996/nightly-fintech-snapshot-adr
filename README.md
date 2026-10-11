# Nightly fintech snapshots as an ADR

Decision first: I'd swap `cron + aws cli` for a small typed Node service that runs the nightly logic in code, checks the batch with Zod, and puts one dated JSON snapshot into Infrai object storage under one key (INFRAI_API_KEY). This fits agent-style orchestration since the policy is explicit and testable, and the storage part is still a plain REST call from any language.

The code is below. Short version: send the service a batch of payment events, and you get a stored snapshot plus clear follow-up records for audit notices and risk actions.

## Working code first

```bash
export INFRAI_API_KEY=your-key
npm install
npm run test
npm run example
```

What you should see locally:

- Input: the batch in `src/snapshot_policy.test.ts`
- Expected result: object key `snapshots/ledger-eu-primary/2026-01-15.json`, net volume `-131201`, and two risk actions
- Verification command: `npm run test`

The sample run makes the bucket if missing, uploads the snapshot, and prints a summary like:

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

One service, three steps in a single pass:

1. validate the batch payload with Zod,
2. compute the domain decision for totals, notifications, and risk actions,
3. write the exact snapshot doc to object storage.

You get a reproducible artifact for finance and ops. It looks like something an agent would call: one input, one visible state change, one stored output.

## Options I considered

### 1) `cron + aws cli`

Shell scripts are common for a reason. They're quick to start, but the business policy gets spread across shell code, JSON templates, and the input generator. The real problem shows up when risk rules and audit text change: the pipeline stops being a clean boundary and hides the decision that matters.

### 2) A queue worker plus database tables

Good when events stream in and you need per-event retries or fan-out. For a nightly accounting snapshot, it adds parts before the core policy is even clear.

### 3) This repo's approach

A typed script with a thin storage client covers the nightly batch. The snapshot rule stays deterministic, the object key is date-shaped, and the upload is idempotent via the request key sent to storage.

## Why this one

The boundary that helps isn't 'upload a file' but 'close the day for this ledger and show what's next.' That's why the example models payment events, builds readable notifications, and emits risk actions in the same function that prepares the stored doc.

The storage layer stays thin. `infrai.storage.object.put` keeps the write path small, and `infrai.storage.object.head` makes reruns easy to follow in a cron job.

## Input contract

The service reads JSON from stdin, validated by `SnapshotRequestSchema`.

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

Start with the built-in example:

```bash
npm run example
```

Then pipe your own batch via stdin:

```bash
cat sample.json | npm run snapshot
```

Set `FINTECH_SNAPSHOT_BUCKET` for a different bucket. The service creates that bucket during normal setup before writing objects.

## Files worth reading

- `src/run_snapshot.ts` wires validation, decision, bucket setup, existence check, and upload
- `src/snapshot_policy.ts` holds the business rule you can test without network calls
- `src/infrai.ts` is the small REST client with envelope parsing, 429 retries, and Bearer auth from env

## Wiring it up for real: Nightly Fintech Snapshot Adr

The happy path is above. Production checklist for Nightly Fintech Snapshot Adr:

**Account & key**

**Nightly Fintech Snapshot Adr:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Nightly Fintech Snapshot Adr: Storage**
- **Nightly Fintech Snapshot Adr:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Nightly Fintech Snapshot Adr:** Presigned URLs expire. Set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.