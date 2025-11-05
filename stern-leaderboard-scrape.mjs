// stern-leaderboard-scrape.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const arg = process.argv[2] || '';
if (!arg) {
  console.error('Usage: node stern-leaderboard-scrape.mjs <SUITE_ID or FULL_URL>');
  process.exit(2);
}

function isUuidish(s) { return /^[0-9a-fA-F-]{32,40}$/.test(s); }
function suiteToUrl(suite) { return `https://insider.sternpinball.com/leaderboard/kiosk/${suite}`; }
function urlToSuite(u) {
  try { const url = new URL(u); const parts = url.pathname.split('/').filter(Boolean); return parts.at(-1) || null; }
  catch { return null; }
}

const TARGET_URL = isUuidish(arg) ? suiteToUrl(arg) : arg;
const SUITE_ID   = isUuidish(arg) ? arg : (urlToSuite(arg) || 'unknown');

// Extract games currently visible in the DOM (single snapshot)
async function extractGamesSnapshot(page) {
  return await page.$$eval('div[class^="kiosk-leaderboard_kioskLeaderboard"]', (blocks) => {
    const onlyDigits = (s) => (s || '').replace(/[^\d]/g, '');
    const numish     = (s) => /^\D*\d[\d,.\s]*\D*$/.test(s || '');
    const hasScoreLikeInName = (s) => /\d{1,3}(?:,\d{3})+(?:\b|$)/.test(s || '');

    const getBgUrl = (el) => {
      const bg = el?.style?.backgroundImage || '';
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      return m ? m[1] : null;
    };

    const resolveNextImageSrc = (imgEl) => {
      if (!imgEl) return null;
      const src = imgEl.getAttribute('src') || '';
      // Try to unwrap Next.js optimizer param ?url=...
      try {
        const u = new URL(src, location.origin);
        const p = u.searchParams.get('url');
        return p ? decodeURIComponent(p) : src;
      } catch {
        return src || null;
      }
    };

    return Array.from(blocks).map((block) => {
      const titleEl = block.querySelector('h4[class*="leaderboard-game-title_name"]');
      const title = (titleEl?.textContent || '').trim();

      const artEl = block.querySelector('div[class*="leaderboard-game-title_backglass"]');
      const art   = getBgUrl(artEl);

      const rowEls = block.querySelectorAll('div[class^="leaderboard-score_leaderboardScore"]');
      const rows = [];
      for (const el of rowEls) {
        const rankTxt  = el.querySelector('h5[class^="leaderboard-score_rank"]')?.textContent?.trim() || '';
        const nameTxt  = el.querySelector('h5[class^="leaderboard-score_username"]')?.textContent?.trim() || '';
        const scoreTxt = el.querySelector('h5[class^="leaderboard-score_scorePoints"]')?.textContent?.trim() || '';

        // Avatar bits
        const avatarWrap = el.querySelector('div[class*="leaderboard-score_avatar"]');
        const avatarBg   = avatarWrap?.style?.backgroundColor || null;
        const avatarImg  = resolveNextImageSrc(avatarWrap?.querySelector('img'));

        const rank  = parseInt(onlyDigits(rankTxt)) || null;
        const score = numish(scoreTxt) ? parseInt(onlyDigits(scoreTxt)) : null;

        // Skip junk/ticker rows or malformed rows
        if (!rank || !score || !nameTxt || hasScoreLikeInName(nameTxt)) continue;

        rows.push({
          rank,
          player: nameTxt,
          score,
          score_formatted: scoreTxt || null,
          avatar_bg: avatarBg,     // e.g. "rgb(57, 157, 97)"
          avatar_img: avatarImg    // resolved original image URL when possible
        });
      }
      rows.sort((a,b)=>a.rank-b.rank);

      return { game: title, art, rows };
    }).filter(g => g.rows.length > 0);
  });
}


async function captureAllGamesOverTime(page, {
  durationMs = 40000,
  pollMs     = 600,
  settleMs   = 1200,
  gentleScroll = true
} = {}) {
  const start = Date.now();
  const byKey = new Map();
  const keyOf = (g) => `${(g.game||'').toLowerCase()}||${(g.art||'').toLowerCase()}`;

  const nudge = async () => {
    if (!gentleScroll) return;
    try {
      await page.evaluate(() => {
        window.scrollBy(0, 800);
        setTimeout(()=>window.scrollTo(0, 0), 50);
      });
    } catch {}
  };

  try { await page.waitForSelector('div[class^="kiosk-leaderboard_kioskLeaderboard"]', { timeout: 15000 }); } catch {};

  while (Date.now() - start < durationMs) {
    const snap = await extractGamesSnapshot(page);
    for (const g of snap) {
      const k = keyOf(g);
      const prev = byKey.get(k);
      if (!prev || (g.rows?.length||0) > (prev.rows?.length||0)) byKey.set(k, g);
    }
    await nudge();
    await page.waitForTimeout(pollMs);
  }

  await page.waitForTimeout(settleMs);
  const finalSnap = await extractGamesSnapshot(page);
  for (const g of finalSnap) {
    const k = keyOf(g);
    const prev = byKey.get(k);
    if (!prev || (g.rows?.length||0) > (prev.rows?.length||0)) byKey.set(k, g);
  }

  return Array.from(byKey.values()).sort((a,b)=>(a.game||'').localeCompare(b.game||''));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  const games = await captureAllGamesOverTime(page, { durationMs: 40000, pollMs: 600 });
  await browser.close();

  await fs.mkdir(path.join(process.cwd(), 'public', 'data'), { recursive: true });
  const out = {
    suite: SUITE_ID,
    target: TARGET_URL,
    scraped_at: new Date().toISOString(),
    pages_base: "https://solidstatekc.github.io/ichlb/data",
    games,
    rows: games.flatMap(g => g.rows)
  };
  const outPath = path.join('public', 'data', SUITE_ID + '.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');

  const totalRows = games.reduce((n,g)=> n + (g.rows ? g.rows.length : 0), 0);
  console.log('Saved', outPath, '(' + totalRows + ' rows across ' + games.length + ' game(s))');
})().catch(e => { console.error(e); process.exit(1); });
