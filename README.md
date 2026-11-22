# Local sync POC

Requires Node.js 20 or newer and npm. From a fresh checkout run:

```sh
npm install && npm run demo
```

The demo checks a duplicate webhook, a late older event, and different fields surviving independently. It starts a separate worker process with the local fake CRM down, shows failed attempts and retries counting against the rate limit, then restarts the worker with its pending work and rate window intact. The fake CRM stores the update and generates an integration-user echo through the same inbound handler; assertions check that no further outbound call occurs.

The POC uses one JSON file and a simulated clock for a single worker. It assumes unique event IDs and comparable timestamps; source and event ID break ties as described in the design. It does not establish Salesforce's actual event, ordering, history recovery, conditional-write, or identity capabilities. JSON writes are not crash-safe transactions and the limiter is not shared between concurrent workers. Postgres, HTTPS, real authentication, full record mapping, conditional writes, and replay are not implemented. See [the design](docs/design.md) for the production requirements and open questions.
