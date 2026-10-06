import test from "node:test";
import assert from "node:assert/strict";
import { decideNightlySnapshot } from "./snapshot_policy";

test("nightly snapshot marks chargebacks and large refunds for follow-up", () => {
  const result = decideNightlySnapshot({
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
  });

  assert.equal(result.objectKey, "snapshots/ledger-eu-primary/2026-01-15.json");
  assert.equal(result.totals.capturedCount, 1);
  assert.equal(result.totals.refundedCount, 1);
  assert.equal(result.totals.chargebackCount, 1);
  assert.equal(result.totals.netVolumeMinor, -131201);
  assert.deepEqual(result.riskActions, [
    {
      payment_id: "pay_1002",
      action: "hold_refund_audit",
      reason: "Refund is at or above 1000 units in minor currency."
    },
    {
      payment_id: "pay_1003",
      action: "review_chargeback",
      reason: "Chargeback entered the nightly batch."
    }
  ]);
  assert.equal(result.notifications[1]?.channel, "email");
});
