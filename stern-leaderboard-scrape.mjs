// stern-leaderboard-scrape.mjs
// Run: node stern-leaderboard-scrape.mjs <SUITE_ID or FULL_URL>

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const arg = process.argv[2] || '';
if (!arg) {
  console.error('Usage: node stern-leaderboard-scrape.mjs <SUITE_ID or FULL_URL>');
  process.exit(2);
}

function isUuidish(s) {
  return /^[0-9a-fA-F-]{32,40}$/.test(s);
}
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

// DOM extraction (table-first)
async function extractRows(page) {
  // Try table
  try { await page.waitForSelector('table tbody tr', { timeout: 15000 }); } catch {}
  const tableInfo = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    if (!tables.length) return null;
    const s = tables.map((t, i) => ({ rows: t.querySelectorAll('tbody tr').length, selector: `table:nth-of-type(${i + 1})` }))
                    .sort((a,b)=>b.rows-a.rows);
    return s[0] || null;
  });

  if (tableInfo && tableInfo.rows > 0) {
    return await page.$$eval(`${tableInfo.selector} tbody tr`, (trs) => {
      const onlyDigits = (s) => (s||'').replace(/[^\d]/g,'');
      const numish = (s) => /^\D*\d[\d,.\s]*\D*$/.test(s||'');
      const out = [];
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('th,td')).map(td=>td.textContent.trim()).filter(Boolean);
        if (!cells.length) continue;
        let rank=null, player=null, scoreFmt=null;
        if (cells.length >= 3) {
          rank = parseInt(onlyDigits(cells[0])) || null;
          player = cells.slice(1, -1).join(' ').replace(/\s+/g, ' ');
          scoreFmt = cells.at(-1) || null;
        } else if (cells.length === 2) {
          const parts = cells[1].split(/\n+/).map(s=>s.trim()).filter(Boolean);
          rank = parseInt(onlyDigits(cells[0])) || null;
          player = parts.slice(0, -1).join(' ') || cells[1];
          scoreFmt = parts.at(-1) || null;
        } else {
          const parts = cells[0].split(/\n+/).map(s=>s.trim()).filter(Boolean);
          if (parts.length >= 3) {
            rank = parseInt(onlyDigits(parts[0])) || null;
            player = parts.slice(1, -1).join(' ');
            scoreFmt = parts.at(-1) || null;
          } else {
            continue;
          }
        }
        const score = scoreFmt && numish(scoreFmt) ? parseInt(onlyDigits(scoreFmt)) : null;
        out.push({ rank, player, score, score_formatted: scoreFmt || null });
      }
      return out;
    });
  }

  // Fallback: heuristics over divs
  return await page.$$eval('body *', (nodes) => {
    const onlyDigits = (s) => (s||'').replace(/[^\d]/g,'');
    const looksScore = (s) => /\d{1,3}(,\d{3})+/.test(s||'') || /^\d{5,}$/.test((s||'').replace(/[^\d]/g,''));
    const out = [];
    for (const el of nodes) {
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const text = el.innerText?.trim();
      if (!text) continue;
      const lines = text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const rankLine = lines.find(l=>/^\d+$/.test(l));
      const scoreLine = [...lines].reverse().find(looksScore);
      if (!rankLine || !scoreLine) continue;
      const ri = lines.indexOf(rankLine); const si = lines.lastIndexOf(scoreLine);
      let player = null;
      if (si - ri >= 2) player = lines.slice(ri+1, si).join(' ').replace(/\s+/g,' ');
      else player = lines.find((l,i)=>i!==ri && i!==si && !/^\d+$/.test(l)) || null;
      if (!player) continue;
      out.push({
        rank: parseInt(onlyDigits(rankLine)) || null,
        player,
        score: parseInt(onlyDigits(scoreLine)) || null,
        score_formatted: scoreLine
      });
    }
    // Dedup
    const seen = new Set();
    return out.filter(r => { const k = `${r.rank}|${r.player}|${r.score}`; if (seen.has(k)) return false; seen.add(k); return true; });
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const rows = await extractRows(page);
  await browser.close();

  await fs.mkdir(path.join(process.cwd(), 'public', 'data'), { recursive: true });
  const out = {
    suite: SUITE_ID,
    target: TARGET_URL,
    scraped_at: new Date().toISOString(),
    rows: rows.length,
    data: rows
  };
  const outPath = path.join('public', 'data', `${SUITE_ID}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Saved ${outPath} (${rows.length} rows)`);
})();
