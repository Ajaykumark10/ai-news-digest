import Parser from "rss-parser";
import fs from "fs/promises";
import { FEEDS } from "./feeds.js";

const POOL_FILE = "news-pool.json";
const MAX_AGE_DAYS = 5; // drop items older than this so the pool doesn't grow forever

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (news-digest-bot)" }
});

async function loadPool() {
  try {
    const raw = await fs.readFile(POOL_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {}; // first run, no pool file yet
  }
}

async function fetchCategory(category, urls) {
  const items = [];
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      for (const entry of feed.items || []) {
        items.push({
          title: entry.title ? entry.title.trim() : "",
          link: entry.link,
          source: feed.title || url,
          published: entry.isoDate || entry.pubDate || new Date().toISOString(),
          snippet: (entry.contentSnippet || entry.summary || "").slice(0, 400)
        });
      }
    } catch (err) {
      console.error(`[${category}] failed to fetch ${url}: ${err.message}`);
    }
  }
  return items;
}

function dedupeAndTrim(existing, incoming) {
  const byLink = new Map();
  for (const item of [...existing, ...incoming]) {
    if (item.link) byLink.set(item.link, item);
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return [...byLink.values()]
    .filter(item => new Date(item.published).getTime() >= cutoff)
    .sort((a, b) => new Date(b.published) - new Date(a.published));
}

async function main() {
  const pool = await loadPool();

  for (const [category, urls] of Object.entries(FEEDS)) {
    const fresh = await fetchCategory(category, urls);
    const prior = pool[category] || [];
    pool[category] = dedupeAndTrim(prior, fresh);
    console.log(`[${category}] pool now has ${pool[category].length} items`);
  }

  await fs.writeFile(POOL_FILE, JSON.stringify(pool, null, 2));
  console.log("Pool updated.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
