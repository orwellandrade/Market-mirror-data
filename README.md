# Market Mirror Data

A scheduled cache of public Kalshi market metadata used by Market Mirror.

- `data/kalshi-markets.json` is refreshed by GitHub Actions.
- No Kalshi credentials, account data, prices, or positions are stored here.
- The collector uses Kalshi's public market-data API with pagination, throttling, and retry backoff.
