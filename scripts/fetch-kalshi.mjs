import { mkdir, writeFile } from "node:fs/promises";

const TARGET_LIMIT = 20_000;
const PLAYER_PROP_LIMIT = 2_000;
const RAW_SCAN_LIMIT = 100_000;
const PAGE_SIZE = 1_000;
const HOSTS = [
  "https://external-api.kalshi.com",
  "https://api.elections.kalshi.com",
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlayerProp(market) {
  const strikeKeys = Object.keys(market.custom_strike || {}).join(" ");
  if (/player|athlete|pitcher|batter|quarterback|goalie/i.test(strikeKeys)) return true;
  const text = [
    market.title,
    market.subtitle,
    market.yes_sub_title,
    market.no_sub_title,
    market.event_ticker,
  ].filter(Boolean).join(" ");
  const playerStat = /\b(points?|rebounds?|assists?|rbis?|hits?|runs?|strikeouts?|home runs?|touchdowns?|passing|receiving|rushing|goals?|saves?|shots?|aces?|birdies?)\b/i;
  const sportsTicker = /KX(?:MLB|NBA|WNBA|NFL|NHL|PGA|ATP|WTA|NCAAB|NCAAF|SOCCER)/i;
  return sportsTicker.test(text) && playerStat.test(text);
}

function compactMarket(market, playerProp) {
  return {
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    title: market.title,
    subtitle: market.subtitle || market.yes_sub_title || market.no_sub_title || "",
    status: market.status,
    open_time: market.open_time,
    close_time: market.close_time,
    expected_expiration_time: market.expected_expiration_time,
    volume_fp: market.volume_fp,
    volume_24h_fp: market.volume_24h_fp,
    market_mirror_player_prop: playerProp,
  };
}

async function request(path) {
  let lastError = "request failed";
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const host of HOSTS) {
      try {
        const response = await fetch(host + path, {
          headers: {
            accept: "application/json",
            "user-agent": "MarketMirrorCollector/1.1 (+https://github.com/orwellandrade/Market-mirror-data)",
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
  const accepted = new Map();
  let cursor = "";
  let sourceHost = "";
  let rawScanned = 0;
  let playerProps = 0;
  let playerPropsExcluded = 0;

  while (accepted.size < TARGET_LIMIT && rawScanned < RAW_SCAN_LIMIT) {
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

    for (const market of page) {
      rawScanned++;
      if (!market?.ticker || accepted.has(market.ticker)) continue;
      const playerProp = isPlayerProp(market);
      if (playerProp && playerProps >= PLAYER_PROP_LIMIT) {
        playerPropsExcluded++;
        continue;
      }
      if (playerProp) playerProps++;
      accepted.set(market.ticker, compactMarket(market, playerProp));
      if (accepted.size >= TARGET_LIMIT) break;
    }

    cursor = body.cursor || "";
    if (!cursor || page.length === 0) break;
    await wait(1_000);
  }

  const markets = [...accepted.values()];
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/kalshi-markets.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: sourceHost,
        status: "ok",
        target: TARGET_LIMIT,
        retrieved: markets.length,
        rawScanned,
        playerProps,
        playerPropsExcluded,
        markets,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Saved ${markets.length} markets from ${rawScanned} scanned; ${playerProps} player props included and ${playerPropsExcluded} excluded`,
  );
}

collect().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
