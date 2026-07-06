import fs from "fs/promises";

const POOL_FILE = "news-pool.json";
const STATE_FILE = "digest-state.json";
const DIGEST_INTERVAL_HOURS = 48; // "post once every 2 days"

const CATEGORY_LABELS = {
  ai: "AI",
  cloud: "Cloud",
  hardware: "Hardware",
  quantum: "Quantum Computing",
  education: "Education / EdTech"
};

// How old a story is allowed to be (in hours) at digest time before it's
// treated as "nothing genuinely new" and skipped instead of forced in.
// AI/Cloud/Hardware move fast, so a slightly wider window still feels current.
// Quantum and Education move slower, so we're stricter here — better to
// skip than post something that's already stale news.
const FRESHNESS_HOURS = {
  ai: 72,
  cloud: 72,
  hardware: 72,
  quantum: 96,
  education: 60
};

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

async function callClaude(promptText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY secret");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: promptText }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === "text");
  return textBlock ? textBlock.text : "";
}

function buildPrompt(picked) {
  const storyLines = Object.entries(picked)
    .map(([cat, item]) => {
      if (!item) return `${CATEGORY_LABELS[cat]}: (no fresh story available this cycle)`;
      return `${CATEGORY_LABELS[cat]}: "${item.title}" — ${item.snippet} (Source: ${item.source}, ${item.link})`;
    })
    .join("\n\n");

  return `You are a social media assistant for a startup COO who posts on X (Twitter) and LinkedIn once every 2 days about the latest developments in tech. Below are the most important recent stories in five categories: AI, Cloud, Hardware, Quantum Computing, and Education/EdTech.

For EACH category below that has a story, write:
1. An X post (under 280 characters, punchy, no hashtag spam — max 2 hashtags, include the source link)
2. A LinkedIn post (3-5 short paragraphs, professional but conversational tone, explain WHY this matters and who benefits — e.g. cloud users, AI startups/learners, hardware engineers, educators — end with a question to spark discussion, include the source link)

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "ai": { "x_post": "...", "linkedin_post": "..." },
  "cloud": { "x_post": "...", "linkedin_post": "..." },
  "hardware": { "x_post": "...", "linkedin_post": "..." },
  "quantum": { "x_post": "...", "linkedin_post": "..." },
  "education": { "x_post": "...", "linkedin_post": "..." }
}
If a category has no story, set its value to null.

Stories:
${storyLines}`;
}

function pickBestPerCategory(pool) {
  const picked = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const items = pool[cat] || [];
    const newest = items[0]; // pool is already sorted newest-first
    if (!newest) {
      picked[cat] = null;
      continue;
    }
    const ageHours = (Date.now() - new Date(newest.published).getTime()) / 3600000;
    const limit = FRESHNESS_HOURS[cat] ?? 72;
    if (ageHours > limit) {
      console.log(`[${cat}] newest story is ${ageHours.toFixed(0)}h old (limit ${limit}h) — skipping, nothing genuinely new.`);
      picked[cat] = null;
    } else {
      picked[cat] = newest;
    }
  }
  return picked;
}

function removeUsedItems(pool, picked) {
  for (const [cat, item] of Object.entries(picked)) {
    if (!item) continue;
    pool[cat] = (pool[cat] || []).filter(i => i.link !== item.link);
  }
  return pool;
}

function formatIssueBody(picked, drafts) {
  let body = `# Content Digest — ${new Date().toISOString().slice(0, 10)}\n\n`;
  body += `Pick whichever drafts you like, tweak, and post manually to X / LinkedIn.\n\n---\n\n`;

  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const item = picked[cat];
    const draft = drafts[cat];
    body += `## ${label}\n\n`;
    if (!item || !draft) {
      body += `_Nothing genuinely new this cycle — skipped rather than forced._\n\n`;
      continue;
    }
    body += `**Source story:** [${item.title}](${item.link}) — ${item.source}\n\n`;
    body += `**X draft:**\n\n> ${draft.x_post}\n\n`;
    body += `**LinkedIn draft:**\n\n${draft.linkedin_post}\n\n---\n\n`;
  }
  return body;
}

async function createGithubIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo", auto-set by Actions
  if (!token || !repo) throw new Error("Missing GITHUB_TOKEN or GITHUB_REPOSITORY");

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "news-digest-bot"
    },
    body: JSON.stringify({ title, body, labels: ["content-digest"] })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub issue creation failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  const state = await readJson(STATE_FILE, { lastDigestAt: null });
  const hoursSinceLast = state.lastDigestAt
    ? (Date.now() - new Date(state.lastDigestAt).getTime()) / 3600000
    : Infinity;

  if (hoursSinceLast < DIGEST_INTERVAL_HOURS) {
    console.log(`Only ${hoursSinceLast.toFixed(1)}h since last digest (need ${DIGEST_INTERVAL_HOURS}h). Skipping.`);
    return;
  }

  const pool = await readJson(POOL_FILE, {});
  const picked = pickBestPerCategory(pool);

  if (Object.values(picked).every(v => v === null)) {
    console.log("No stories available in the pool yet. Skipping digest.");
    return;
  }

  const prompt = buildPrompt(picked);
  const raw = await callClaude(prompt);
  const clean = raw.replace(/```json|```/g, "").trim();
  const drafts = JSON.parse(clean);

  const issueBody = formatIssueBody(picked, drafts);
  const issueTitle = `Content Digest — ${new Date().toISOString().slice(0, 10)}`;
  const issue = await createGithubIssue(issueTitle, issueBody);
  console.log(`Created issue: ${issue.html_url}`);

  const updatedPool = removeUsedItems(pool, picked);
  await fs.writeFile(POOL_FILE, JSON.stringify(updatedPool, null, 2));
  await fs.writeFile(STATE_FILE, JSON.stringify({ lastDigestAt: new Date().toISOString() }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
