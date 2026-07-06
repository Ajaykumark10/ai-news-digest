# AI News Digest Bot

Automatically pulls the latest news in AI, Cloud, Hardware, Quantum Computing,
and Education/EdTech, then drafts an X post + LinkedIn post for each — once
every 2 days — as a GitHub Issue you can copy-paste from.

## How it works

- **Every 6 hours** (`fetch-news.js`): pulls RSS feeds for all 5 categories,
  adds any new stories to `news-pool.json` (committed to the repo), drops
  anything older than 5 days.
- **Every 6 hours, but only fires every 48 hours** (`generate-digest.js`):
  checks `digest-state.json` for when the last digest ran. If 48+ hours have
  passed, it picks the single newest story per category from the pool, sends
  them to the Claude API to draft posts, and opens a GitHub Issue titled
  "Content Digest — YYYY-MM-DD" with everything ready to copy-paste.

You never have to think about timing — the workflow runs every 6 hours no
matter what, but only *publishes* a digest every 2 days.

## Setup (10 minutes)

1. **Create a new GitHub repo** (can be private) and push all these files to it:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

2. **Add your Anthropic API key as a repo secret:**
   - Go to your repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from https://console.anthropic.com/settings/keys
   - (`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.)

3. **Enable Actions** if prompted (Settings → Actions → Allow all actions).

4. **Test it manually** before waiting for the schedule:
   - Go to the "Actions" tab → "News Pool + Content Digest" → "Run workflow"
   - Note: since there's no `digest-state.json` yet, the very first run will
     generate a digest immediately (even with a small/thin pool). After that,
     it waits a full 48 hours before generating the next one.

5. **Check the Issues tab** every 2 days for your "Content Digest" post —
   copy whichever draft you like into X or LinkedIn.

## Customizing sources

Edit `feeds.js` to add/remove RSS feed URLs per category. Any standard RSS
or Atom feed URL works.

## Customizing the writing style

Edit the prompt inside `generate-digest.js` (`buildPrompt` function) — e.g.
add "make it sound more casual" or "always mention how this affects Indian
startups" etc.

## Costs

- RSS fetching: free.
- GitHub Actions: free for public repos; ~free tier minutes cover this easily
  even for private repos (this job takes under a minute to run).
- Claude API: charged per digest generation (roughly every 2 days) — very
  low cost, a few cents per run depending on how much news text gets sent.
