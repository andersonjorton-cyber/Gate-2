// The Gate — live game-log API + static host.
// Zero dependencies. Node 18+ (uses built-in fetch).
//
//   GET /                         -> the app
//   GET /api/search?league=&q=    -> [{id, name, team}]
//   GET /api/log?league=&id=&stat=&n=5
//   GET /api/health
//
// Sources (both free, no API key):
//   MLB  statsapi.mlb.com
//   WNBA site.api.espn.com + site.web.api.espn.com

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 3000;
const SEASON = process.env.SEASON || new Date().getFullYear();
const UA     = 'the-gate/1.0';

// ── tiny TTL cache ────────────────────────────────────────────────
const cache = new Map();
function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.val;
  const val = Promise.resolve(fn()).catch(err => { cache.delete(key); throw err; });
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ESPN hands out intermittent 503s under any real traffic. Retry 5xx and
// network faults with backoff; fail fast on 4xx, which won't fix itself.
async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(300 * 2 ** (i - 1));
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) return r.json();
      last = new Error(`${r.status} ${url}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
  }
  throw last;
}

// ── stat maps ─────────────────────────────────────────────────────
// what the user asks for -> what the source calls it
const MLB_PITCH = {
  strikeouts: 'strikeOuts', outs: 'outs', hits_allowed: 'hits',
  earned_runs: 'earnedRuns', walks: 'baseOnBalls', pitches: 'numberOfPitches',
};
const MLB_HIT = {
  hits: 'hits', total_bases: 'totalBases', home_runs: 'homeRuns',
  rbi: 'rbi', runs: 'runs', stolen_bases: 'stolenBases', batter_strikeouts: 'strikeOuts',
  hits_runs_rbis: ['hits', 'runs', 'rbi'],
};
const WNBA = {
  points: 'points', rebounds: 'totalRebounds', assists: 'assists',
  steals: 'steals', blocks: 'blocks', turnovers: 'turnovers',
  threes: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  pra: ['points', 'totalRebounds', 'assists'],
  pr:  ['points', 'totalRebounds'],
  pa:  ['points', 'assists'],
  ra:  ['totalRebounds', 'assists'],
  stocks: ['steals', 'blocks'],
};
const num = v => {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes('-')) return parseFloat(s.split('-')[0]) || 0; // "3-10" -> 3
  return parseFloat(s) || 0;
};
const pick = (row, key) =>
  Array.isArray(key) ? key.reduce((t, k) => t + num(row[k]), 0) : num(row[key]);

// ── MLB ───────────────────────────────────────────────────────────
async function mlbSearch(q) {
  const d = await getJSON(
    `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(q)}&active=true`);
  return (d.people || []).slice(0, 8).map(p => ({
    id: String(p.id),
    name: p.fullName,
    team: p.currentTeam?.name || '',
    pos: p.primaryPosition?.abbreviation || '',
  }));
}
const mlbTeams = () => memo('mlb:teams', 12 * 3600e3, async () => {
  const d = await getJSON('https://statsapi.mlb.com/api/v1/teams?sportId=1');
  return Object.fromEntries((d.teams || []).map(t => [t.id, t.abbreviation]));
});
async function mlbLog(id, stat, n) {
  const pitching = stat in MLB_PITCH;
  const key = pitching ? MLB_PITCH[stat] : MLB_HIT[stat];
  if (!key) throw new Error(`unknown MLB stat "${stat}"`);
  const [d, abbr] = await Promise.all([
    getJSON(`https://statsapi.mlb.com/api/v1/people/${id}/stats` +
      `?stats=gameLog&group=${pitching ? 'pitching' : 'hitting'}&season=${SEASON}`),
    mlbTeams(),
  ]);
  const splits = d.stats?.[0]?.splits || [];
  return splits.slice(-n).reverse().map(g => ({
    date: g.date,
    opp: (g.isHome ? '' : '@') +
         (abbr[g.opponent?.id] || g.opponent?.abbreviation || g.opponent?.name || ''),
    v: pick(g.stat, key),
  }));
}

// ── WNBA ──────────────────────────────────────────────────────────
// ESPN's search endpoint resolves a name to an athlete id in one request.
// (An earlier version walked all 15 team rosters — ESPN rate-limits that
// and silently dropped whole teams from the index.)
async function wnbaSearch(q) {
  const d = await getJSON('https://site.web.api.espn.com/apis/common/v3/search' +
    `?region=us&lang=en&limit=12&mode=prefix&type=player&query=${encodeURIComponent(q)}`);
  return (d.items || [])
    .filter(it => it.type === 'player' && it.league === 'wnba')
    .slice(0, 8)
    .map(it => ({ id: String(it.id), name: it.displayName, team: '' }));
}

async function wnbaLog(id, stat, n) {
  const key = WNBA[stat];
  if (!key) throw new Error(`unknown WNBA stat "${stat}"`);
  const d = await getJSON(
    `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${id}/gamelog`);
  const labels = d.names || d.labels || [];
  const rows = [];
  for (const st of d.seasonTypes || [])
    for (const c of st.categories || [])
      for (const e of c.events || []) rows.push(e);
  return rows.slice(0, n).map(r => {
    const ev = d.events?.[r.eventId] || {};
    const row = Object.fromEntries(labels.map((l, i) => [l, r.stats[i]]));
    return {
      date: (ev.gameDate || '').slice(0, 10),
      opp: (ev.atVs === '@' ? '@' : '') + (ev.opponent?.abbreviation || ''),
      v: pick(row, key),
    };
  });
}

// ── routes ────────────────────────────────────────────────────────
const APP = path.join(__dirname, 'The_Gate.html');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(JSON.stringify(obj));
  };

  try {
    if (u.pathname === '/api/health') return send(200, { ok: true, season: SEASON });

    if (u.pathname === '/api/search') {
      const league = (u.searchParams.get('league') || '').toLowerCase();
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 2) return send(400, { error: 'q must be 2+ characters' });
      const r = await memo(`s:${league}:${q.toLowerCase()}`, 6 * 3600e3,
        () => (league === 'wnba' ? wnbaSearch(q) : mlbSearch(q)));
      return send(200, r);
    }

    if (u.pathname === '/api/log') {
      const league = (u.searchParams.get('league') || '').toLowerCase();
      const id = u.searchParams.get('id');
      const stat = (u.searchParams.get('stat') || '').toLowerCase();
      const n = Math.min(parseInt(u.searchParams.get('n') || '5', 10) || 5, 25);
      if (!id) return send(400, { error: 'id required' });
      const games = await memo(`l:${league}:${id}:${stat}:${n}`, 10 * 60e3,
        () => (league === 'wnba' ? wnbaLog(id, stat, n) : mlbLog(id, stat, n)));
      return send(200, { league, id, stat, games });
    }

    // static: the app
    if (u.pathname === '/' || u.pathname === '/index.html') {
      if (!fs.existsSync(APP)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('The_Gate.html not found in repo root');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(APP).pipe(res);
    }

    send(404, { error: 'not found' });
  } catch (err) {
    send(502, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`the-gate listening on ${PORT} (season ${SEASON})`));
