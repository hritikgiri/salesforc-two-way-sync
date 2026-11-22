# Two-way customer and contact sync

## 1. Assumptions and open questions

This is a proposed design, conditional on the existing Salesforce setup. Salesforce remains unchanged. The brief requires visibility within 30 seconds while both systems are up, complete edit history, and 5 million customers and contacts combined. Those guarantees cannot be established until the blockers below are resolved.

| Provisional assumption or question | If it is wrong, or the answer differs |
| --- | --- |
| Peak portal edits needing Salesforce calls are 10/sec; quiet-hour traffic is 0.1/sec. The calculation assumes one call per edit and 10/sec throughout the outage and recovery. What are burst size, sustained rates, Salesforce-side rates, and actual calls per edit? | Higher or burstier traffic, additional calls, or a smaller available budget increases latency and recovery time; if arrivals consume effective capacity, the backlog never drains. Quiet-hour traffic does not establish the six-hour rate. |
| Outbound budget is 80 calls/sec, including retries, within the brief's 100/sec maximum. Are other clients sharing that cap? | Reduce the shared budget if others consume it; throttling or failed calls further slows recovery. Salesforce's instruction to slow down takes precedence. |
| Webhooks contain all changed fields, including explicit nulls, with stable unique event IDs, an actor and `occurredAt`, as in the sample. Is each edit delivered as a distinct event, and how are these values authenticated? | A full-record payload needs a trustworthy way to identify changed fields; missing or incomplete changes prevent accurate per-field history. Missing stable IDs or actor information blocks the stated deduplication or audit guarantee. |
| Portal actor is the authenticated session; Postgres assigns the portal timestamp at save. Are its precision and clock synchronization with Salesforce sufficient, and what happens at equal timestamps? | Clock skew, ties, and transaction timing can make timestamp order differ from real edit order; use an agreed alternative ordering or accept that the winner is deterministic rather than provably latest. |
| For two portal users changing the same field, accept both saves, retain both in history, show the winner after refresh, and send only the current winner. Is that acceptable? | If users must be warned or reject stale saves, the portal needs a version check and conflict response; the outbound path follows the chosen result. |
| Can the existing Salesforce setup replay **every** missed change with value, actor, timestamp, stable event identity and order, for long enough to cover outage and recovery? Does it expose a durable cursor and a bounded replay/live handoff? | If yes, use that existing capability as described below. If no, complete history across lost webhooks is a blocker. A current-record query can at best reconcile current values; it cannot reconstruct intermediate edits, actors or times. No Salesforce configuration or new fields are assumed. |
| Does the existing webhook reliably identify the integration user, and is that identity exclusive? Is there an existing correlation identifier? | Without reliable origin/correlation, do not infer an echo solely from equal values. Inbound changes do not automatically generate outbound calls, but safe conflict repair and attribution of echoes can require an existing signal; ambiguous cases need reconciliation or manual review. |
| Does the existing record API provide conditional update/version checks and safe create idempotency or a reliable way to resolve an ambiguous create result? | Without these capabilities, concurrent Salesforce edits can be overwritten and a timed-out create can duplicate a record. Pause ambiguous work for reconciliation rather than claim exactly-once effects or automatic convergence. |
| Can initial records and independently created customers/contacts be matched using existing stable identifiers? How are owner and customer references mapped? | Without reliable matching, duplicate creates and unresolved relationships need a manual process; contacts must wait for a mapped customer. |
| What are the webhook authentication, acknowledgement, retry and payload-size contracts? Are delivery and API latency bounded within the 30-second target? | Adapt validation and acknowledgement to the existing contract. Without bounded delivery, processing and API latency, the worst-case target cannot be guaranteed. |
| The example refers to a billing city, while the field list puts city on contacts. Which record owns it? | The answer changes the mapping and the record that receives the edit. |

## 2. Systems and interfaces

Sales users use Salesforce; finance and customer-success users use our portal. Each system stores its own records. Salesforce calls our webhook endpoint over public HTTPS. Our worker calls Salesforce's existing official record create/update API over HTTPS; users do not call the other system directly. Webhooks are outside the outbound API cap.

```text
Sales user -> Salesforce --HTTPS webhook--> our endpoint -> Postgres
                     ^                                    ^
                     | HTTPS record API                   |
                     +--------- our worker <------- durable outbox
                                                          ^
Portal user -> our portal -------------------------------> Postgres
```

The endpoint and worker are separate processes of our service; their boundary is committed Postgres rows, not an in-memory queue. The endpoint accepts the sample's `eventId`, `recordId`, `objectType`, `occurredAt`, `changedBy`, and `changedFields`, validates the existing authentication contract and allowed fields, and responds according to the confirmed delivery contract. The worker sends only allowed changed fields through the existing record API, using the existing Salesforce identity and mapping. Credentials and authentication details must be confirmed, not invented.

## 3. Subproblems in build order

1. Confirm replay, identity, concurrency and create guarantees: these determine whether history and safe convergence are possible at all.
2. Establish identity mapping, field-level version and history rules: both directions must agree on what a record and an edit mean.
3. Make inbound acceptance and portal saves transactional in Postgres: accepted changes and pending work must survive restarts before network retries are introduced.
4. Add the outbox worker, shared rate control and failure handling: external calls can fail or have ambiguous outcomes.
5. Add recovery and replay handoff, then monitoring: recovery depends on the preceding rules and on capabilities already present in Salesforce.

## 4. Data in Postgres

- Current customer and contact rows contain only the brief's fields, local ID, Salesforce ID when mapped, and relationship mappings. Index the Salesforce ID and contact/customer relationship; size storage and indexes for 5 million records plus history.
- A per-record, per-field version row stores the winning value, ordering tuple, source event ID and actor. Lock affected version rows in a stable order when updating them.
- Append-only history records each distinct observed field edit, including value (and previous observed value when known), actor, source, source time, ordering tuple, event ID and receipt time. A late or losing edit remains in history. Do not claim an inferred previous value is the actual predecessor when events are missing or unordered.
- A webhook inbox/deduplication table has a unique event ID, payload or reference, receipt and processing status. Its retention must cover the provider's retry and replay horizon. Invalid events go to a durable quarantine with an alert.
- An outage/replay checkpoint stores the last **contiguous, durably applied** source cursor and recovery status, if the existing replay interface supplies such a cursor. Advance it atomically with applying each event; never advance past a gap. If no suitable cursor exists, recovery remains blocked pending an alternative existing capability.
- A durable outbox stores operation ID, local and Salesforce IDs, operation type, intended field values and versions, status, attempt count, next attempt, lease and last error. Record the local edit, history, versions and outbox work in one transaction. Index ready work and reclaim expired leases after restart.

## 5. Inbound webhook to Postgres

1. Authenticate and validate the request and allowed object/fields, including explicit nulls. Reject invalid or unauthenticated input according to the confirmed contract; do not acknowledge an uncommitted event as applied.
2. In one transaction insert the event ID under a unique constraint, append each changed field to history, lock its version row and apply the comparison in section 7. Commit before sending the success acknowledgement. A duplicate produces no second history entry or state change.
3. An inbound change alone does not enqueue a write back to Salesforce. If it conflicts with pending portal work, reevaluate that work under the version rules before sending. Durable reconciliation of a losing Salesforce value requires the concurrency capabilities in section 6; do not silently assume they exist.
4. If a replay source exists, feed replayed events through the same deduplication and application path. Acknowledge or checkpoint only after commit.

## 6. Portal edit to Salesforce

Authenticate the portal user. In one Postgres transaction, assign the save timestamp, record the actor and each field edit, compare and update per-field versions, and insert durable outbox work for winning local edits. Return the committed current values to the portal. A later concurrent winner becomes visible on refresh; confirm whether the product requires an explicit conflict notice.

Workers claim ready outbox rows with leases. Before sending, recheck each field's current version; do not send a superseded value. Resolve customer/owner mappings and wait when a dependency is missing. Use the official record create/update API over HTTPS. A shared limiter across workers permits at most 80 outbound attempts/sec, including retries; it must enforce the provider's actual window semantics and remain effective across worker restarts. Honor a lower Salesforce throttle, back off with jitter, and keep work durable. Successful confirmed calls mark work complete; transient failures remain pending, permanent validation failures are quarantined and alerted.

A local recheck cannot prevent a Salesforce edit between the check and the API write. Safe automatic handling requires an existing conditional write/version mechanism or another confirmed concurrency guarantee; otherwise pause or reconcile uncertain conflicts, and do not promise preservation/convergence. For timeouts where Salesforce may have applied the request, use only an existing idempotency or reliable lookup capability; in particular, do not blindly retry an ambiguous create. Without such capability, hold it for manual reconciliation. API calls and any recovery calls sharing the cap all consume the budget.

## 7. Concurrent edits and per-field versions

Compare each field independently using the lexicographic tuple `(source timestamp, source rank, stable source event ID)`. Use Salesforce `occurredAt` for a webhook and the Postgres-assigned save timestamp for a portal edit. Source rank is a fixed documented tie-breaker (portal sorts after Salesforce); the stable ID breaks remaining ties. Store the winning tuple per field. This gives a repeatable total order, not proof of real-world order: skew, timestamp precision, and transaction timing can select an earlier edit. Confirm clock bounds and business acceptance before implementation; if unacceptable, agree on a different conflict policy.

Different-field edits must both survive: a Salesforce phone update changes only the phone version, and a portal city update changes only the city version. For the same field, append both observed edits, select the greater tuple for current state, and arrange a safe outbound correction only when the existing API guarantees allow it. If an older webhook arrives after a newer value, preserve its history but do not replace that field's newer current value. Do not overwrite unrelated fields in an update. A full-record webhook would need reliable changed-field metadata or a different conflict procedure; comparing entire snapshots alone is insufficient.

## 8. Duplicates and out-of-order delivery

A unique inbox constraint makes repeated delivery of the same `eventId` a no-op after the first committed transaction; an acknowledgement lost after commit is therefore safe to retry. If the same ID arrives with a different payload, quarantine and alert rather than silently discard it. Apply each distinct event's changed fields independently using section 7, even when delivery order differs. This preserves observed stale edits in history but cannot reconstruct events that never arrive.

## 9. Loop prevention

An inbound webhook is applied locally and is not itself placed in the outbox. Portal saves create outbound work; an echo of that write therefore does not automatically create another write. If the existing webhook reliably identifies an exclusive integration user, mark its event as an echo for attribution and process it through deduplication and ordering; use an existing correlation signal if confirmed. Never suppress an independent edit just because its value matches a recent write. Without reliable actor or correlation support, origin cannot be proven; automatic conflict correction must not repeatedly write solely because a webhook arrived, and ambiguous cases require reconciliation. This prevents a simple echo loop but does not establish safe automatic resolution of every concurrent race.

## 10. Six-hour outage and recovery

During the Salesforce API outage, portal saves continue in Postgres: current values, versions, history and pending outbox operations remain on disk and survive a worker process restart. Failed attempts consume the outbound budget; apply backoff, retain work, and resume when Salesforce is available. The committed inbox and last contiguous replay checkpoint also remain on disk. Database durability and availability are prerequisites; the brief does not require a second region.

After recovery, use the existing replay interface **only if confirmed**. Resume from the durable checkpoint, overlap with live delivery as needed and deduplicate by stable event ID; advance the checkpoint only after contiguous application and a confirmed handoff with no gap. Respect replay retention and any shared API limit. If replay cannot deliver complete change history, raise an incident: fetching current records may reconcile latest values but cannot recover missed intermediate values, actors, timestamps, or evidence of changes later reversed. It cannot satisfy the history requirement.

For the requested outbound arithmetic, assume one successful request per edit and an available 80 requests/sec throughout recovery:

- Backlog: `10 edits/sec × 6 × 3,600 sec = 216,000 calls`.
- No new work: `216,000 ÷ 80 = 2,700 sec = 45 minutes`.
- With 10 new edits/sec: `216,000 ÷ (80 − 10) = 3,085.7 sec ≈ 51.4 minutes`.

These are ideal lower bounds. They exclude failed attempts and retries, throttling, calls by other clients, replay or reconciliation requests sharing the budget, multiple calls per edit, dependency delays, and processing or network overhead. All attempts count against the limit. If effective successful capacity does not exceed ongoing arrivals, the backlog cannot drain. Thirty seconds applies while both systems are up; these are separate outage catch-up estimates.

## 11. Three operational numbers

1. **Oldest eligible outbox age:** call someone at 20 seconds while both systems are healthy, before the 30-second target is breached. During declared outage recovery, track against the recovery estimate and investigate stalled progress.
2. **End-to-end inbound event age:** call someone at 20 seconds from Salesforce `occurredAt` to committed application while healthy. Clock skew affects this measurement; verify clocks and measure delivery separately when possible.
3. **Replay gap or cursor lag:** call someone immediately on a detected gap, replay failure, or unavailable replay capability after an outage; also alert before the confirmed replay retention expires. If no cursor exists this metric cannot prove completeness, which is itself a blocker.

## 12. Out of scope this weekend

Deletes, Salesforce login screens, a visual UI, a second region, and load testing against real Salesforce are excluded by the brief. A production service and changes to Salesforce configuration or schema are also outside this exercise. A program is optional; any demo uses a local fake CRM. Initial matching, operational procedures and capability confirmation remain design questions, not claims that those features already exist.
