import { Buffer } from "node:buffer";
import { infrai } from "./infrai";
import { SnapshotRequestSchema, decideNightlySnapshot, type SnapshotRequest } from "./snapshot_policy";

const bucketName = process.env.FINTECH_SNAPSHOT_BUCKET || "fintech-nightly-snapshots-demo";

async function ensureBucket(name: string): Promise<void> {
  await infrai.storage.bucket.create({ name });
}

function exampleInput(): SnapshotRequest {
  return {
    snapshot_date: "2026-01-15",
    ledger_id: "ledger-eu-primary",
    events: [
      {
        payment_id: "pay_1001",
        account_id: "acct_77",
        amount_minor: 2599,
        currency: "USD",
        status: "captured",
        created_at: "2026-01-15T01:10:00Z",
        customer_email: "buyer@example.com"
      },
      {
        payment_id: "pay_1002",
        account_id: "acct_77",
        amount_minor: 125000,
        currency: "USD",
        status: "refunded",
        created_at: "2026-01-15T04:40:00Z"
      },
      {
        payment_id: "pay_1003",
        account_id: "acct_81",
        amount_minor: 8800,
        currency: "USD",
        status: "chargeback",
        created_at: "2026-01-15T06:20:00Z"
      }
    ]
  };
}

async function loadInput(): Promise<SnapshotRequest> {
  if (process.argv.includes("--example")) {
    return exampleInput();
  }

  const raw = await new Promise<string>((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });

  return JSON.parse(raw) as SnapshotRequest;
}

async function main(): Promise<void> {
  const input = SnapshotRequestSchema.parse(await loadInput());
  const decision = decideNightlySnapshot(input);

  await ensureBucket(bucketName);

  const existing = await infrai.storage.object.head(bucketName, decision.objectKey);
  if (existing.data.found) {
    console.log(JSON.stringify({
      bucket: bucketName,
      objectKey: decision.objectKey,
      alreadyPresent: true,
      totals: decision.totals,
      notifications: decision.notifications,
      riskActions: decision.riskActions
    }, null, 2));
    return;
  }

  const upload = await infrai.storage.object.put(bucketName, decision.objectKey, {
    data_base64: Buffer.from(decision.snapshotJson, "utf8").toString("base64"),
    content_type: "application/json",
    idempotency_key: decision.idempotencyKey
  });

  console.log(JSON.stringify({
    bucket: bucketName,
    objectKey: decision.objectKey,
    uploaded: true,
    totals: decision.totals,
    notifications: decision.notifications,
    riskActions: decision.riskActions,
    metadata: upload.metadata
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
