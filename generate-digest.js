import fs from "fs/promises";

const POOL_FILE = "news-pool.json";
const STATE_FILE = "digest-state.json";
const DIGEST_INTERVAL_HOURS = 12; // "at least 2 digests per 24 hours"

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
      max_tokens: 4096,
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

function buildPrompt(candidates) {
  const sections = Object.entries(candidates)
    .map(([cat, items]) => {
      const label = CATEGORY_LABELS[cat];
      if (!items.length) return `### ${label}\n(no candidates available this cycle)`;
      const lines = items
        .map((item, i) => `[${i}] "${item.title}" — ${item.snippet} (Source: ${item.source}, published: ${item.published}, link: ${item.link})`)
        .join("\n");
      return `### ${label}\n${lines}`;
    })
    .join("\n\n");

  return `You are a social media assistant for a startup COO who posts on X (Twitter) and LinkedIn once every 2 days about the latest developments in tech.

Below are up to 5 recent candidate stories in each of five categories: AI, Cloud, Hardware, Quantum Computing, and Education/EdTech.

For EACH category:
1. Judge the candidates by genuine SIGNIFICANCE, not just recency — prioritize major product launches, funding rounds, research breakthroughs, notable policy/regulatory shifts, or anything with broad impact on the field. Deprioritize minor incremental updates, routine patch notes, or low-impact announcements UNLESS nothing better is available.
2. Pick the single most significant candidate by its bracketed index (e.g. 0, 1, 2...).
3. If NONE of the candidates in a category feel genuinely significant or newsworthy, set "selected_index" to null for that category rather than forcing a weak pick.
4. For the category's selected story, write:
   - An X post (under 280 characters, punchy, no hashtag spam — max 2 hashtags, include the source link)
   - A LinkedIn post (3-5 short paragraphs, professional but conversational tone, explain WHY this matters and who benefits — e.g. cloud users, AI startups/learners, hardware engineers, educators — end with a question to spark discussion, include the source link)

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "ai": { "selected_index": 0, "x_post": "...", "linkedin_post": "..." },
  "cloud": { "selected_index": 0, "x_post": "...", "linkedin_post": "..." },
  "hardware": { "selected_index": 0, "x_post": "...", "linkedin_post": "..." },
  "quantum": { "selected_index": 0, "x_post": "...", "linkedin_post": "..." },
  "education": { "selected_index": 0, "x_post": "...", "linkedin_post": "..." }
}
If a category has "selected_index": null, omit "x_post" and "linkedin_post" (or set them to null) for that category.

Candidates:
${sections}`;
}

function getCandidatesPerCategory(pool, maxPerCategory = 5) {
  const candidates = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const items = pool[cat] || []; // already sorted newest-first
    const limit = FRESHNESS_HOURS[cat] ?? 72;
    const fresh = items.filter(item => {
      const ageHours = (Date.now() - new Date(item.published).getTime()) / 3600000;
      return ageHours <= limit;
    });
    candidates[cat] = fresh.slice(0, maxPerCategory);
  }
  return candidates;
}

function resolvePicks(candidates, drafts) {
  const picked = {};
  const resolvedDrafts = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const draft = drafts[cat];
    const idx = draft ? draft.selected_index : null;
    if (idx === null || idx === undefined || !candidates[cat] || !candidates[cat][idx]) {
      picked[cat] = null;
      resolvedDrafts[cat] = null;
      continue;
    }
    picked[cat] = candidates[cat][idx];
    resolvedDrafts[cat] = { x_post: draft.x_post, linkedin_post: draft.linkedin_post };
  }
  return { picked, resolvedDrafts };
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
  const candidates = getCandidatesPerCategory(pool);

  if (Object.values(candidates).every(list => list.length === 0)) {
    console.log("No candidates available in the pool yet. Skipping digest.");
    return;
  }

  const prompt = buildPrompt(candidates);
  const raw = await callClaude(prompt);
  const clean = raw.replace(/```json|```/g, "").trim();

  let rawDrafts;
  try {
    rawDrafts = JSON.parse(clean);
  } catch (err) {
    console.error("Failed to parse Claude's response as JSON. Raw response below:");
    console.error(clean);
    throw err;
  }

  const { picked, resolvedDrafts } = resolvePicks(candidates, rawDrafts);

  if (Object.values(picked).every(v => v === null)) {
    console.log("Claude didn't find any candidate significant enough this cycle. Skipping digest.");
    return;
  }

  const issueBody = formatIssueBody(picked, resolvedDrafts);
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
