// Quiz-show game server: host + teams + buzzers + wagers + final round.
const crypto = require('crypto');
const BOARDS = require('./boards');
const games = new Map();
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COLORS = ['#e63946', '#2ec4b6', '#ffbe0b', '#8d6bff'];
const NAMES = ['Red Rockets', 'Teal Tigers', 'Gold Geese', 'Violet Vipers'];
const VALUES = [200, 400, 600, 800, 1000];
const rid = (n) => Array.from(crypto.randomBytes(n), (b) => CH[b % CH.length]).join('');
const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(+v) || 0));

function create(boardId, teamCount) {
  const b = BOARDS.find((x) => x.id === boardId) || BOARDS[0];
  let code; do code = rid(4); while (games.has(code));
  const n = num(teamCount, 2, 4) || 2;
  const dd = [Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 4)]; // never top... row 1..4
  const g = {
    code, board: b, phase: 'lobby', host: null, hostToken: crypto.randomUUID(),
    teams: Array.from({ length: n }, (_, i) => ({ id: i, name: NAMES[i], color: COLORS[i], score: 0 })),
    players: new Map(), used: new Set(), dd, control: 0, cur: null, final: null, created: Date.now(),
  };
  games.set(code, g);
  return g;
}

function viewFor(g, role, p) {
  const host = role === 'host';
  const cur = g.cur;
  const curView = cur && {
    c: cur.c, i: cur.i, cat: g.board.categories[cur.c].name, value: VALUES[cur.i], dd: cur.dd,
    stage: cur.stage, wager: cur.wager, team: cur.team, buzzer: cur.buzzer, buzzed: cur.buzzed,
    lockedOut: cur.lockedOut, showAnswer: cur.showAnswer,
    clue: cur.stage === 'wager' ? null : g.board.categories[cur.c].clues[cur.i][0],
    answer: host || cur.showAnswer ? g.board.categories[cur.c].clues[cur.i][1] : null,
  };
  const f = g.final;
  const finalView = f && {
    stage: f.stage, category: g.board.final.category, deadline: f.deadline,
    clue: f.stage === 'category' ? null : g.board.final.clue,
    answer: host || f.stage === 'reveal' ? g.board.final.answer : null,
    wagered: Object.keys(f.wagers).map(Number), answered: Object.keys(f.answers).map(Number),
    revealed: f.revealed, judged: f.judged,
    entries: host || f.stage === 'reveal' ? Object.fromEntries(g.teams.map((t) => [t.id, {
      wager: f.revealed.includes(t.id) || host ? f.wagers[t.id] ?? 0 : undefined,
      answer: f.revealed.includes(t.id) || host ? f.answers[t.id] ?? '' : undefined,
    }])) : null,
    myWagerMax: p && p.team != null ? Math.max(0, g.teams[p.team].score) : 0,
  };
  return {
    type: 'state', role, code: g.code, phase: g.phase, board: g.board.id, boardTitle: g.board.title,
    cats: g.board.categories.map((c) => c.name), values: VALUES, used: [...g.used],
    ddCells: host ? [g.dd] : [], teams: g.teams, control: g.control, cur: curView, final: finalView,
    players: [...g.players.values()].map((x) => ({ id: x.id, name: x.name, team: x.team, on: !!x.ws })),
    me: p ? { id: p.id, name: p.name, team: p.team } : null,
  };
}
function push(g) {
  send(g.host, viewFor(g, 'host'));
  for (const p of g.players.values()) send(p.ws, viewFor(g, 'player', p));
}
function closeClue(g) {
  const c = g.cur; if (!c) return;
  g.used.add(c.c + ',' + c.i); g.cur = null; g.phase = 'board';
  if (g.used.size >= 30) { /* board cleared: host can start final */ }
}
function lockCheck(g) { // if every team is locked out, reveal the answer
  const c = g.cur;
  if (c && c.lockedOut.length >= g.teams.length) { c.showAnswer = true; c.buzzer = 'closed'; c.buzzed = null; }
}

function attach(wss) {
  wss.on('connection', (ws) => {
    let g = null, role = null, me = null;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'create') {
        g = create(m.board, m.teams); role = 'host'; g.host = ws;
        send(ws, { type: 'joined', code: g.code, role, token: g.hostToken }); return push(g);
      }
      if (m.type === 'join') {
        const x = games.get(String(m.code || '').toUpperCase().trim());
        if (!x) return send(ws, { type: 'error', text: 'Game not found. Check the code.' });
        if (m.token && m.token === x.hostToken) { g = x; role = 'host'; g.host = ws; send(ws, { type: 'joined', code: g.code, role, token: g.hostToken }); return push(g); }
        let p = [...x.players.values()].find((y) => m.token && y.token === m.token);
        if (!p) {
          if (x.players.size >= 40) return send(ws, { type: 'error', text: 'Game is full.' });
          p = { id: rid(6), token: crypto.randomUUID(), name: String(m.name || 'Player').trim().slice(0, 16) || 'Player', team: null, ws: null };
          x.players.set(p.id, p);
        }
        g = x; me = p; p.ws = ws; role = 'player';
        send(ws, { type: 'joined', code: g.code, role, token: p.token }); return push(g);
      }
      if (!g) return;
      if (role === 'player') return playerMsg(g, me, m, ws);
      hostMsg(g, m);
    });
    ws.on('close', () => { if (g && me && me.ws === ws) { me.ws = null; push(g); } });
  });
  setInterval(() => { for (const [k, g] of games) if (Date.now() - g.created > 24 * 3600 * 1000) games.delete(k); }, 600000);
}

function playerMsg(g, p, m, ws) {
  const c = g.cur, f = g.final;
  switch (m.type) {
    case 'team':
      if (m.team === null || (Number.isInteger(m.team) && g.teams[m.team])) { p.team = m.team; push(g); }
      break;
    case 'buzz':
      if (c && c.buzzer === 'open' && p.team != null && !c.lockedOut.includes(p.team) && (!c.dd)) {
        c.buzzer = 'locked'; c.buzzed = { team: p.team, player: p.name }; push(g);
      }
      break;
    case 'finalWager':
      if (f && f.stage === 'category' && p.team != null)
        f.wagers[p.team] = num(m.amount, 0, Math.max(0, g.teams[p.team].score)), push(g);
      break;
    case 'finalAnswer':
      if (f && f.stage === 'clue' && p.team != null && Date.now() < f.deadline + 2000)
        f.answers[p.team] = String(m.text || '').slice(0, 80), push(g);
      break;
  }
}

function hostMsg(g, m) {
  const c = g.cur, f = g.final;
  switch (m.type) {
    case 'teams': // {count, names[]}
      if (g.phase !== 'lobby') break;
      { const n = num(m.count, 2, 4) || 2;
        while (g.teams.length < n) { const i = g.teams.length; g.teams.push({ id: i, name: NAMES[i], color: COLORS[i], score: 0 }); }
        g.teams.length = n;
        (m.names || []).forEach((nm, i) => { if (g.teams[i] && String(nm).trim()) g.teams[i].name = String(nm).trim().slice(0, 18); });
        g.players.forEach((p) => { if (p.team != null && p.team >= n) p.team = null; }); }
      break;
    case 'assign': { const p = g.players.get(m.player); if (p && (m.team === null || g.teams[m.team])) p.team = m.team; break; }
    case 'start': if (g.phase === 'lobby') g.phase = 'board'; break;
    case 'pick': {
      if (g.phase !== 'board') break;
      const ci = +m.c, ri = +m.i; if (!(ci >= 0 && ci < 6 && ri >= 0 && ri < 5) || g.used.has(ci + ',' + ri)) break;
      const dd = g.dd[0] === ci && g.dd[1] === ri;
      g.cur = { c: ci, i: ri, dd, stage: dd ? 'wager' : 'clue', team: dd ? g.control : null, wager: 0, buzzer: 'closed', buzzed: null, lockedOut: [], showAnswer: false };
      g.phase = 'clue'; break;
    }
    case 'ddTeam': if (c && c.dd && c.stage === 'wager' && g.teams[m.team]) c.team = m.team; break;
    case 'ddWager': // host enters the wager for the team
      if (c && c.dd && c.stage === 'wager') {
        const max = Math.max(1000, g.teams[c.team].score);
        c.wager = num(m.amount, 5, max) || 5; c.stage = 'clue';
      }
      break;
    case 'openBuzz': if (c && !c.dd && !c.showAnswer && c.buzzer !== 'open') { c.buzzer = 'open'; c.buzzed = null; } break;
    case 'judge': { // m.correct bool
      if (!c || !(c.dd || c.buzzed)) break;
      const tid = c.dd ? c.team : c.buzzed.team, val = c.dd ? c.wager : VALUES[c.i], t = g.teams[tid];
      if (m.correct) { t.score += val; g.control = tid; c.showAnswer = true; c.buzzer = 'closed'; c.buzzed = null; c.result = 'right'; }
      else {
        t.score -= val;
        if (c.dd) { c.showAnswer = true; c.result = 'wrong'; }
        else { c.lockedOut.push(tid); c.buzzed = null; c.buzzer = 'closed'; lockCheck(g); }
      }
      break;
    }
    case 'reveal': if (c) { c.showAnswer = true; c.buzzer = 'closed'; } break;
    case 'close': closeClue(g); break;
    case 'adjust': { const t = g.teams[m.team]; if (t) t.score += num(m.delta, -5000, 5000) * (m.delta < 0 ? 1 : 1) || 0; break; }
    case 'control': if (g.teams[m.team]) g.control = m.team; break;
    case 'final': if (g.phase === 'board') { g.phase = 'final'; g.final = { stage: 'category', wagers: {}, answers: {}, deadline: 0, revealed: [], judged: [] }; } break;
    case 'finalClue': if (f && f.stage === 'category') { f.stage = 'clue'; f.deadline = Date.now() + 30000; } break;
    case 'finalReveal': if (f && f.stage === 'clue') f.stage = 'reveal'; break;
    case 'finalShow': if (f && f.stage === 'reveal' && g.teams[m.team] && !f.revealed.includes(m.team)) f.revealed.push(m.team); break;
    case 'finalJudge':
      if (f && f.stage === 'reveal' && g.teams[m.team] && !f.judged.includes(m.team)) {
        const w = f.wagers[m.team] || 0; g.teams[m.team].score += m.correct ? w : -w; f.judged.push(m.team);
        if (!f.revealed.includes(m.team)) f.revealed.push(m.team);
      }
      break;
    case 'end': g.phase = 'ended'; break;
  }
  push(g);
}
module.exports = { attach, boards: BOARDS.map((b) => ({ id: b.id, title: b.title, blurb: b.blurb })) };
