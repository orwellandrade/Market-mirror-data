import { mkdir, writeFile } from "node:fs/promises";

const MAX_SCANNED = 100_000;
const TARGET_LIMIT = 20_000;
const PAGE_SIZE = 1_000;
const HOSTS = [
  "https://external-api.kalshi.com",
  "https://api.elections.kalshi.com",
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCongressional2026(market) {
  const text = [market.title, market.subtitle, market.ticker, market.event_ticker]
    .filter(Boolean)
    .join(" ");
  if (/primary|nominee|nomination|state house|state senate|legislature|general assembly/i.test(text)) return false;
  const year = /2026|(?:HOUSE|SENATE)[A-Z]{2}D26|(?:HOUSE|SENATE).*26/i.test(text);
  const federal = /u\.?s\.? (?:house|senate)|united states (?:house|senate)|congress|midterm|controlh|controls|(?:house|senate).{0,30}(?:election|seat|control|party)|\b[A-Z]{2}-?\d{1,2}\b/i.test(text);
  return year && federal;
}

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
  const targets = new Map();
  let cursor = "";
  let sourceHost = "";
  let scanned = 0;

  while (scanned < MAX_SCANNED && targets.size < TARGET_LIMIT) {
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
    scanned += page.length;
    for (const market of page) if (isCongressional2026(market)) targets.set(market.ticker, market);
    cursor = body.cursor || "";

    if (!cursor || page.length === 0) break;
    await wait(750);
  }

  const markets = [...targets.values()];
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/kalshi-markets.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: sourceHost,
        status: "ok",
        scanned,
        retrieved: markets.length,
        scope: "active 2026 U.S. House and Senate general-election markets",
        markets,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Scanned ${scanned} open Kalshi markets; saved ${markets.length} congressional markets from ${sourceHost}`);
}

collect().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
