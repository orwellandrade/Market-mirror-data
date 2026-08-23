import { mkdir, writeFile } from "node:fs/promises";

const LIMIT = 10_000;
const PAGE_SIZE = 1_000;
const HOSTS = [
  "https://external-api.kalshi.com",
  "https://api.elections.kalshi.com",
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path) {
  let lastError = "request failed";
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const host of HOSTS) {
      try {
        const response = await fetch(host + path, {
          headers: {
            accept: "application/json",
            "user-agent": "MarketMirrorCollector/1.0 (+https://github.com/orwellandrade/Market-mirror-data)",
          },
        });
        if (response.ok) return { response, host };
        lastError = `${new URL(host).hostname}: HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) continue;
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) ? retryAfter * 1_000 : Math.min(60_000, 2_000 * 2 ** attempt));
      } catch (error) {
        lastError = `${new URL(host).hostname}: ${error instanceof Error ? error.message : "network error"}`;
      }
    }
    await wait(Math.min(60_000, 2_000 * 2 ** attempt));
  }
  throw new Error(lastError);
}

async function collect() {
  const markets = [];
  let cursor = "";
  let sourceHost = "";

  while (markets.length < LIMIT) {
    const query = new URLSearchParams({
      status: "open",
      mve_filter: "exclude",
      limit: String(PAGE_SIZE),
    });
    if (cursor) query.set("cursor", cursor);

    const { response, host } = await request(`/trade-api/v2/markets?${query}`);
    sourceHost = new URL(host).hostname;
    const body = await response.json();
    const page = Array.isArray(body.markets) ? body.markets : [];
    markets.push(...page);
    cursor = body.cursor || "";

    if (!cursor || page.length === 0) break;
    await wait(1_000);
  }

  const unique = [...new Map(markets.map((market) => [market.ticker, market])).values()].slice(0, LIMIT);
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/kalshi-markets.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: sourceHost,
        status: "ok",
        retrieved: unique.length,
        markets: unique,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Saved ${unique.length} open Kalshi markets from ${sourceHost}`);
}

collect().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
