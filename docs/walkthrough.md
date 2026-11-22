# Ten-minute sync walkthrough

## 0:00–2:00 — Assumptions and open questions

I'll start with the assumptions that shape the design and the questions I'd ask before locking it. We have about five million customers and contacts together, and the target is for a create or update to appear on the other side within 30 seconds while both systems are up. Salesforce stays as it is.

For capacity, I'm assuming a peak of ten portal edits per second that each need one Salesforce call, and quiet-hour traffic of 0.1 per second. I reserve 80 outbound calls per second, including retries, under the stated 100-call limit. I'd confirm the burst size, sustained rates, Salesforce-side traffic and whether other clients share that limit. More traffic or a smaller budget changes both latency and recovery time.

I assume each webhook contains the changed fields, including explicit nulls, and has a stable event ID, actor and Salesforce event time. For portal edits, the actor comes from the authenticated session and Postgres assigns the save time. I'd confirm the webhook contract, timestamp precision and clock synchronization. If the clocks aren't comparable, the proposed ordering can choose a repeatable winner without proving which edit actually happened last.

The most consequential question is whether the existing Salesforce setup can replay every missed edit with its value, actor, time, identity and order, with enough retention for recovery. If it cannot, we cannot guarantee the required history after lost webhooks. I'd also confirm whether the existing integration user or a correlation signal identifies echoes, whether conditional writes and safe create retries are available, and how records, owners and customer relationships map across systems. Without those capabilities, some conflicts or ambiguous creates require reconciliation rather than automatic resolution.

## 2:00–4:00 — Who calls whom

Sales users work in Salesforce. Finance and customer-success users work in our portal. Each system has its own copy of the records, and our portal stores its copy in Postgres.

When Salesforce changes a record, Salesforce calls our webhook endpoint over HTTPS. The endpoint validates the request under the existing authentication contract. It records the event ID, appends the observed changes to history, and applies the field version rule in one Postgres transaction. Only after commit does it acknowledge the event, according to the delivery contract we still need to confirm.

In the other direction, a portal user saves an edit to our application. In one Postgres transaction we record the actor, timestamp and history, update the current field versions, and put any winning local changes in a durable outbox. A separate worker reads that outbox and calls Salesforce's existing record create or update API over HTTPS. The boundary between endpoint and worker is committed Postgres data, not an in-memory queue.

The worker rechecks the current version before sending, so it doesn't knowingly send a value already superseded locally. It shares the 80-call budget across workers, counts every attempt including retries, and slows down when Salesforce asks. Failed work remains durable. The local recheck alone can't prevent a Salesforce edit between that check and our write, so safe automatic handling depends on an existing conditional write or another confirmed concurrency guarantee.

## 4:00–7:00 — Conflict, order and loop rules

I'll use a phone and city example. Suppose a sales user changes the phone in Salesforce while a portal user changes the city. We compare and store versions per field. The phone update must not erase the city update, and the city update must not erase the phone update. An outbound update includes only the relevant changed fields.

When both sides change the same field, we keep both observed edits in append-only history, including the actor and source time. For the current value, the proposed ordering compares a tuple: source timestamp, source rank, then stable event ID. Salesforce supplies `occurredAt`; Postgres supplies the portal save time. If times tie, portal sorts after Salesforce, and the ID breaks any remaining tie. This makes the result repeatable. It doesn't prove real-world order if clocks differ or timestamp precision is insufficient, so we need agreement on those limits.

For two portal users changing the same field, the provisional behavior is to accept both saves, retain both in history, show the winner after refresh and send only the current winner. I'd confirm whether users instead need an explicit conflict warning or a rejected stale save. For a conflict involving Salesforce, safe outbound correction still depends on the existing concurrency guarantees; we should not promise automatic convergence without them.

Now consider delivery order. If the webhook for a newer phone value arrives first and an older one arrives later, we retain the older observed edit in history but don't replace the newer current value. Each field is compared separately. For duplicate delivery, the event ID has a unique constraint: after the first committed application, the same event is a no-op. If the same ID comes with a different payload, we quarantine it and alert rather than silently discard it.

For loops, an inbound webhook updates our local state but does not itself create an outbound call. A portal save creates outbound work, so when that write echoes back, the echo does not automatically create another write. If the existing webhook reliably identifies an exclusive integration user, we can mark the event as an echo for attribution; an existing correlation signal could help if confirmed. We don't infer an echo just because a value matches. Without reliable origin information, we can't prove the origin of every event, and ambiguous conflict repair needs reconciliation. The rule prevents the simple echo loop; it doesn't settle every concurrent race.

## 7:00–8:30 — Six-hour outage and recovery

During a six-hour Salesforce API outage, portal users can still save into Postgres. Current values, field versions, history and pending outbox work stay on disk, along with committed inbox entries and the last contiguous replay checkpoint if the existing interface supplies one. A worker restart must not lose the pending calls. Failed attempts consume the outbound budget, so the worker backs off and retains the work.

When Salesforce returns, the worker drains the outbox. For missed inbound events, we use replay only if the existing Salesforce setup already supports it. We resume from the durable checkpoint, apply replayed events through the same handler and deduplication rule, and advance the checkpoint only after contiguous application and a confirmed handoff with live delivery.

If complete replay isn't available, we raise an incident. Fetching current records may reconcile the latest values, but it cannot recover an intermediate value, who made that missed edit, when it happened, or an edit that was later reversed. That leaves the history requirement unmet; it isn't something this design can create by assuming a new Salesforce capability.

## 8:30–10:00 — Backlog arithmetic and operational signals

For the outbound calculation, assume ten portal edits a second for all six hours and one successful Salesforce request per edit. Six hours is 21,600 seconds. Ten times 21,600 gives a backlog of 216,000 calls.

If no new work arrives during recovery, divide 216,000 by 80 calls a second. That's 2,700 seconds, or 45 minutes. If ten new edits keep arriving each second, only 70 calls a second are available to drain the backlog. Divide 216,000 by 70 and we get about 3,086 seconds, or 51.4 minutes.

Those are ideal lower bounds. They exclude failed attempts and retries, throttling, other clients, recovery calls sharing the budget, extra calls per edit, dependencies and processing overhead. All attempts count against the budget. If effective successful capacity doesn't exceed new arrivals, the backlog won't drain. The 30-second target applies while both systems are up; catch-up is a separate target.

To operate this, I'd call someone if the oldest eligible outbox item reaches 20 seconds while both systems are healthy, or if inbound event age reaches 20 seconds, allowing for the effect of clock skew on that measurement. I'd also alert immediately on a replay gap or failure, or if replay is unavailable after an outage, and before the confirmed retention window expires. The design excludes deletes, a visual UI, a second region and load testing against real Salesforce for this exercise.
