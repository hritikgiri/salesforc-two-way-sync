# Open questions for the design review

These questions reflect the design in `docs/design.md`. The assumptions are provisional and must be confirmed against the existing Salesforce setup; Salesforce changes are outside this proposal.

## Feasibility and recovery

1. **Missed changes:** Can the existing Salesforce setup replay every missed change, including its value, actor, timestamp, stable event ID and order? Is retention long enough for the outage and recovery, and is there a durable cursor with a gap-free replay-to-live handoff? Without this, current-state reconciliation cannot recreate missing edit history; the complete history requirement is blocked.
2. **Concurrent writes:** Does the existing record API support conditional updates or another concurrency guarantee? Without it, a Salesforce edit between our local check and API call may be overwritten; uncertain conflicts require reconciliation rather than a promise of automatic convergence.
3. **Ambiguous creates:** Is there an existing idempotency mechanism or reliable lookup for a create whose response timed out? Without one, hold ambiguous creates for manual reconciliation instead of blindly retrying.

## Event contract and identity

4. **Webhook contents:** Does each edit produce a distinct event with a stable unique ID, actor, timestamp, all changed fields and explicit nulls? How are events authenticated? Missing data affects deduplication and history; a full-record payload needs trustworthy changed-field information.
5. **Delivery:** What are the webhook authentication, acknowledgement, retry and payload-size rules? Are delivery and API latencies bounded enough to meet 30 seconds? Without bounds, the worst-case target cannot be guaranteed.
6. **Echoes:** Is the integration user identifiable and exclusive, and is a correlation ID already available? Without a reliable signal, origin is ambiguous; equal values alone do not prove an echo. Inbound events do not automatically create outbound calls, but conflict repair may need manual reconciliation.
7. **Record mapping:** Can existing identifiers match initial and independently created records? How are owner and customer references mapped? Contacts must wait for a mapped customer; unresolved matches require a manual process.
8. **Field ownership:** The example refers to a billing city while the field list places city on contacts. Which record owns it? The answer determines the mapping and target record.

## Ordering, load and operations

9. **Conflict policy:** Is the proposed per-field ordering by source timestamp, source rank and stable event ID acceptable? What clock skew and timestamp precision are expected? This policy is deterministic but cannot prove real-world ordering.
10. **Two portal users:** Is it acceptable to accept both saves, preserve both in history, and show the winner on refresh? If users need a warning or rejection, add a version check and conflict response.
11. **Traffic and API budget:** What are measured peak, burst and quiet rates on each side, and how many calls does each edit require? Do other clients share the 100 calls/second cap? The proposed 80 calls/second budget includes retries; a lower available budget or sustained arrivals at capacity changes latency and recovery estimates.
12. **History and retention:** Where must users see edit history, how long must it be retained, and who may access it? The proposed portal ledger needs retention and access rules agreed before production.

The POC uses a fake CRM, a simulated clock and one worker with JSON persistence. It does not establish these Salesforce capabilities or production durability and concurrency guarantees.
