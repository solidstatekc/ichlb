// stern-leaderboard-scrape.mjs
// Usage: node stern-leaderboard-scrape.mjs <SUITE_ID or FULL_URL>
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const arg = process.argv[2] || '';
if (!arg) {
  console.error('Usage: node stern-leaderboard-scrape.mjs <SUITE_ID or FULL_URL>');
  process.exit(2);
}

function isUuidish(s) { return /^[0-9a-fA-F-]{32,40}$/.test(s); }
function suiteToUrl(suite) {
  return `https://insider.sternpinball.com/leaderboard/kiosk/${suite}`;
}
function urlToSuite(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch { return null; }
}

const TARGET_URL = isUuidish(arg) ? suiteToUrl(arg) : arg;
const SUITE_ID = isUuidish(arg) ? arg : (urlToSuite(arg) || 'unknown');

// --- Multi-game extractor ---
async function extractGames(page) {
  try { await page.waitForSelector('div[class^="kiosk-leaderboard_kioskLeaderboard"]', { timeout: 15000 }); } catch {}
  return await page.$$eval('div[class^="kiosk-leaderboard_kioskLeaderboard"]', (blocks) => {
    const onlyDigits = (s) => (s || '').replace(/[^\d]/g, '');
    const numish     = (s) => /^\D*\d[\d,.\s]*\D*$/.test(s || '');
    const hasScoreLikeInName = (s) => /\d{1,3}(?:,\d{3})+(?:\b|$)/.test(s || '');

    return blocks.map((block) => {
      const titleEl = block.querySelector('h4[class*="leaderboard-game-title_name"]');
      const title = (titleEl?.textContent || '').trim();

      const rowEls = block.querySelectorAll('div[class^="leaderboard-score_leaderboardScore"]');
      const rows = [];
      for (const el of rowEls) {
        const rankTxt   = el.querySelector('h5[class^="leaderboard-score_rank"]')?.textContent?.trim() || '';
        const nameTxt   = el.querySelector('h5[class^="leaderboard-score_username"]')?.textContent?.trim() || '';
        const scoreTxt  = el.querySelector('h5[class^="leaderboard-score_scorePoints"]')?.textContent?.trim() || '';

        const rank  = parseInt(onlyDigits(rankTxt)) || null;
        const score = numish(scoreTxt) ? parseInt(onlyDigits(scoreTxt)) : null;

        if (!rank || !score || !nameTxt || hasScoreLikeInName(nameTxt)) continue;

        rows.push({ rank, player: nameTxt, score, score_formatted: scoreTxt || null });
      }

      rows.sort((a,b)=>a.rank-b.rank);
      return { game: title, rows };
    }).filter(g => g.rows.length > 0);
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const games = await extractGames(page);
  await browser.close();

  await fs.mkdir(path.join(process.cwd(), 'public', 'data'), { recursive: true });
  const out = {
    suite: SUITE_ID,
    target: TARGET_URL,
    scraped_at: new Date().toISOString(),
    games,
    rows: games.flatMap(g => g.rows), // convenience aggregate
  };
  const outPath = path.join('public', 'data', `${SUITE_ID}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Saved ${outPath} (${games.reduce((n,g)=>n+g.rows.length,0)} rows across ${games.length} game(s))`);
})().catch(e => { console.error(e); process.exit(1); });
