import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const run = promisify(execFile);
const MAX_SCANNED = 100_000;
const TARGET_LIMIT = 20_000;
const PAGE_SIZE = 1_000;
const HOSTS = [
  "https://external-api.kalshi.com",
  "https://api.elections.kalshi.com",
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalized = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

function isCongressional2026(market) {
  const text = [market.title, market.subtitle, market.ticker, market.event_ticker]
    .filter(Boolean)
    .join(" ");
  if (/primary|nominee|nomination|state house|state senate|legislature|general assembly/i.test(text)) return false;
  const year = /2026|(?:HOUSE|SENATE)[A-Z]{2}D26|(?:HOUSE|SENATE).*26/i.test(text);
  const federal = /u\.?s\.? (?:house|senate)|united states (?:house|senate)|congress|midterm|controlh|controls|(?:house|senate).{0,30}(?:election|seat|control|party)|\b[A-Z]{2}-?\d{1,2}\b/i.test(text);
  return year && federal;
}

function explicitParty(market) {
  const text = [market.subtitle, market.rules_primary, market.yes_sub_title].filter(Boolean).join(" ");
  if (/\b(?:democrat|democratic)\b/i.test(text)) return "D";
  if (/\b(?:republican|gop)\b/i.test(text)) return "R";
  if (/\bindependent\b/i.test(text)) return "I";
  return "";
}

function candidateName(market) {
  if (market.yes_sub_title && !/^(yes|no)$/i.test(market.yes_sub_title)) return market.yes_sub_title;
  const match = String(market.title || "").match(/^(?:will|does) (.+?) (?:win|be elected)/i);
  return match?.[1] || market.subtitle || "";
}

async function fecParties() {
  const dir = await mkdtemp(join(tmpdir(), "market-mirror-fec-"));
  try {
    const zip = join(dir, "cn26.zip");
    const response = await fetch("https://www.fec.gov/files/bulk-downloads/2026/cn26.zip");
    if (!response.ok) throw new Error(`FEC HTTP ${response.status}`);
    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await run("unzip", ["-p", zip], { maxBuffer: 5_000_000 });
    const parties = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const fields = line.split("|");
      if (fields.length < 7 || !["H", "S"].includes(fields[5]) || fields[3] !== "2026") continue;
      const raw = fields[1] || "", affiliation = fields[2] || "";
      const [last, rest = ""] = raw.split(",", 2);
      const first = rest.trim().split(/\s+/)[0] || "";
      const party = /^DEM/i.test(affiliation) ? "D" : /^REP/i.test(affiliation) ? "R" : /^IND/i.test(affiliation) ? "I" : "";
      if (!party || !last || !first) continue;
      parties.set(normalized(`${first} ${last}`), party);
    }
    return parties;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

  let fec = new Map();
  try { fec = await fecParties(); } catch (error) { console.warn(`FEC fallback unavailable: ${error.message}`); }
  const markets = [...targets.values()].map((market) => ({
    ...market,
    _candidate_name: candidateName(market),
    _candidate_party: explicitParty(market) || fec.get(normalized(candidateName(market))) || "",
  }));
  const partyResolved = markets.filter((market) => market._candidate_party).length;

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
        partyResolved,
        scope: "active 2026 U.S. House and Senate general-election markets",
        markets,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Scanned ${scanned}; saved ${markets.length} congressional markets; resolved ${partyResolved} parties`);
}

collect().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
