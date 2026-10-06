import { createHash } from "node:crypto";
import { z } from "zod";

export const PaymentEventSchema = z.object({
  payment_id: z.string().min(1),
  account_id: z.string().min(1),
  amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.enum(["captured", "refunded", "chargeback"]),
  created_at: z.string().datetime(),
  customer_email: z.string().email().optional()
});

export const SnapshotRequestSchema = z.object({
  snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ledger_id: z.string().min(1),
  events: z.array(PaymentEventSchema).min(1)
});

export type PaymentEvent = z.infer<typeof PaymentEventSchema>;
export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;

export type Notification = {
  channel: "email" | "ops_log";
  subject: string;
  body: string;
};

export type RiskAction = {
  payment_id: string;
  action: "review_chargeback" | "hold_refund_audit";
  reason: string;
};

export type SnapshotDecision = {
  objectKey: string;
  idempotencyKey: string;
  totals: {
    capturedCount: number;
    refundedCount: number;
    chargebackCount: number;
    netVolumeMinor: number;
  };
  notifications: Notification[];
  riskActions: RiskAction[];
  snapshotJson: string;
};

export function decideNightlySnapshot(input: SnapshotRequest): SnapshotDecision {
  const parsed = SnapshotRequestSchema.parse(input);

  let capturedCount = 0;
  let refundedCount = 0;
  let chargebackCount = 0;
  let netVolumeMinor = 0;

  const riskActions: RiskAction[] = [];

  for (const event of parsed.events) {
    if (event.status === "captured") {
      capturedCount += 1;
      netVolumeMinor += event.amount_minor;
    }

    if (event.status === "refunded") {
      refundedCount += 1;
      netVolumeMinor -= event.amount_minor;
      if (event.amount_minor >= 100000) {
        riskActions.push({
          payment_id: event.payment_id,
          action: "hold_refund_audit",
          reason: "Refund is at or above 1000 units in minor currency."
        });
      }
    }

    if (event.status === "chargeback") {
      chargebackCount += 1;
      netVolumeMinor -= event.amount_minor;
      riskActions.push({
        payment_id: event.payment_id,
        action: "review_chargeback",
        reason: "Chargeback entered the nightly batch."
      });
    }
  }

  const digest = createHash("sha256")
    .update(JSON.stringify({ ledger_id: parsed.ledger_id, snapshot_date: parsed.snapshot_date, events: parsed.events }))
    .digest("hex");

  const objectKey = `snapshots/${parsed.ledger_id}/${parsed.snapshot_date}.json`;
  const idempotencyKey = `snapshot-${parsed.ledger_id}-${parsed.snapshot_date}-${digest.slice(0, 16)}`;

  const notifications: Notification[] = [
    {
      channel: "ops_log",
      subject: `Nightly snapshot ready for ${parsed.ledger_id}`,
      body: `${parsed.events.length} events, net volume ${netVolumeMinor}, ${riskActions.length} risk actions.`
    }
  ];

  if (riskActions.length > 0) {
    notifications.push({
      channel: "email",
      subject: `Risk review queued for ${parsed.ledger_id} on ${parsed.snapshot_date}`,
      body: riskActions.map((item) => `${item.payment_id}: ${item.action}`).join("; ")
    });
  }

  const snapshotDocument = {
    snapshot_date: parsed.snapshot_date,
    ledger_id: parsed.ledger_id,
    totals: {
      capturedCount,
      refundedCount,
      chargebackCount,
      netVolumeMinor
    },
    riskActions,
    notifications,
    events: parsed.events
  };

  return {
    objectKey,
    idempotencyKey,
    totals: {
      capturedCount,
      refundedCount,
      chargebackCount,
      netVolumeMinor
    },
    notifications,
    riskActions,
    snapshotJson: JSON.stringify(snapshotDocument, null, 2)
  };
}
