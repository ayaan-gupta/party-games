// Skedaddle — real-world hide & seek. Express + WebSocket, in-memory games.
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const games = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OUT_VISIBLE_MS = 30_000; // outside zone this long => visible live
const OUT_ELIM_MS = 120_000; // outside zone this long => eliminated
const TAG_RANGE_M = 60; // sanity limit for tag claims (GPS is noisy)
const GAME_TTL_MS = 7 * 24 * 3600 * 1000;

const rid = (n) => Array.from(crypto.randomBytes(n), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const now = () => Date.now();

function dist(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

function newGame(settings) {
  let code;
  do code = rid(6); while (games.has(code));
  const g = {
    code, created: now(), phase: 'lobby', players: new Map(), hostId: null,
    settings: {
      mode: settings.mode === 'infection' ? 'infection' : 'classic',
      roundMin: clamp(settings.roundMin, 1, 120, 15),
      headStartMin: clamp(settings.headStartMin, 0, 30, 2),
      pingMin: clamp(settings.pingMin, 0, 30, 3), // 0 = pings off
      zone: settings.zone && Number.isFinite(+settings.zone.lat)
        ? { lat: +settings.zone.lat, lng: +settings.zone.lng, radius: clamp(settings.zone.radius, 30, 20000, 300) } : null,
      shrink: !!settings.shrink,
    },
    headStartEnds: 0, roundEnds: 0, startedAt: 0, lastPing: 0, pings: [], events: [], winner: null,
  };
  games.set(code, g);
  return g;
}

function curZone(g) {
  const z = g.settings.zone;
  if (!z) return null;
  if (!g.settings.shrink || !g.startedAt || g.phase === 'lobby') return z;
  const total = g.roundEnds - g.startedAt;
  const f = Math.min(1, Math.max(0, (now() - g.startedAt) / total));
  return { ...z, radius: z.radius * (1 - 0.6 * f) }; // shrinks to 40%
}

function addEvent(g, text, kind = 'info') {
  g.events.push({ t: now(), text, kind });
  if (g.events.length > 50) g.events.shift();
  broadcast(g, { type: 'event', text, kind });
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(g, msg) { for (const p of g.players.values()) send(p.ws, msg); }

const pub = (p) => ({ id: p.id, name: p.name, team: p.team, status: p.status, color: p.color, connected: !!p.ws });
const COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#8338ec', '#fb5607', '#3a86ff', '#ff006e', '#8ac926', '#ff9f1c'];

// Build the per-player view: enforces who can see whom.
function stateFor(g, me) {
  const t = now();
  const zone = curZone(g);
  const visible = [];
  for (const p of g.players.values()) {
    if (p.id === me.id || !p.pos) continue;
    const sameTeam = p.team === me.team;
    const exposed = p.team === 'runner' && p.status === 'active' && p.outSince && t - p.outSince >= OUT_VISIBLE_MS;
    const spectator = me.status === 'out' && me.team === 'runner' && g.settings.mode === 'classic';
    if (sameTeam || exposed || spectator || g.phase === 'ended') {
      visible.push({ id: p.id, lat: p.pos.lat, lng: p.pos.lng, team: p.team, status: p.status, name: p.name, color: p.color, exposed: !!exposed && !sameTeam });
    }
  }
  const pings = me.team === 'hunter' || g.phase === 'ended'
    ? g.pings.map((x) => ({ ...x, ageSec: Math.round((t - x.at) / 1000) })) : [];
  const out = {
    type: 'state', code: g.code, phase: g.phase, you: me.id, host: g.hostId === me.id,
    settings: g.settings, zone, now: t, headStartEnds: g.headStartEnds, roundEnds: g.roundEnds,
    players: [...g.players.values()].map(pub), visible, pings, winner: g.winner,
    outFor: me.outSince ? Math.round((t - me.outSince) / 1000) : 0,
    pendingTag: me.pendingTag || null, events: g.events.slice(-15),
    outLimits: { visible: OUT_VISIBLE_MS / 1000, elim: OUT_ELIM_MS / 1000 },
  };
  return out;
}

function pushState(g) { for (const p of g.players.values()) send(p.ws, stateFor(g, p)); }

function checkWin(g) {
  if (g.phase !== 'running') return;
  const runners = [...g.players.values()].filter((p) => p.team === 'runner' && p.status === 'active');
  if (runners.length === 0) return endGame(g, 'hunters', 'All runners caught!');
  if (now() >= g.roundEnds) return endGame(g, 'runners', "Time's up — runners survive!");
}
function endGame(g, winner, why) {
  g.phase = 'ended'; g.winner = { team: winner, why };
  addEvent(g, why, 'end');
  broadcast(g, { type: 'vibrate' });
}

function takePings(g) {
  g.pings = [];
  for (const p of g.players.values()) {
    if (p.team === 'runner' && p.status === 'active' && p.pos)
      g.pings.push({ id: p.id, name: p.name, color: p.color, lat: p.pos.lat, lng: p.pos.lng, at: now() });
  }
  g.lastPing = now();
  addEvent(g, 'Ping! Runner locations updated.', 'ping');
  broadcast(g, { type: 'vibrate' });
}

function tick() {
  const t = now();
  for (const g of games.values()) {
    if (t - g.created > GAME_TTL_MS) { games.delete(g.code); continue; }
    if (g.phase === 'headstart' && t >= g.headStartEnds) {
      g.phase = 'running'; addEvent(g, 'Head start over — hunters released!', 'go');
      broadcast(g, { type: 'vibrate' });
      if (g.settings.pingMin) takePings(g);
    }
    if (g.phase === 'running') {
      const zone = curZone(g);
      for (const p of g.players.values()) {
        if (p.team !== 'runner' || p.status !== 'active' || !p.pos || !zone) { p.outSince = null; continue; }
        const outside = dist(p.pos, zone) > zone.radius;
        if (outside && !p.outSince) { p.outSince = t; send(p.ws, { type: 'vibrate' }); send(p.ws, { type: 'toast', text: 'You left the zone! Return now.' }); }
        if (!outside && p.outSince) { p.outSince = null; }
        if (p.outSince && t - p.outSince >= OUT_ELIM_MS) {
          p.status = 'out'; p.outSince = null;
          addEvent(g, `${p.name} stayed outside the zone too long and is out.`, 'tag');
        }
      }
      if (g.settings.pingMin && t - g.lastPing >= g.settings.pingMin * 60_000) takePings(g);
      checkWin(g);
    }
    if (g.phase !== 'lobby') pushState(g);
  }
}
setInterval(tick, 1000);

function tagPlayer(g, runner, hunter) {
  runner.pendingTag = null;
  if (g.settings.mode === 'infection') {
    runner.team = 'hunter';
    addEvent(g, `${runner.name} was tagged by ${hunter.name} and joins the hunters!`, 'tag');
  } else {
    runner.status = 'out';
    addEvent(g, `${runner.name} was tagged by ${hunter.name}.`, 'tag');
  }
  broadcast(g, { type: 'vibrate' });
  checkWin(g);
}

wss.on('connection', (ws) => {
  let game = null, me = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'create') {
      game = newGame(m.settings || {});
      me = addPlayer(game, m.name, m.token);
      game.hostId = me.id; me.ws = ws;
      send(ws, { type: 'joined', code: game.code, token: me.token });
      return pushState(game);
    }
    if (m.type === 'join') {
      const g = games.get(String(m.code || '').toUpperCase().trim());
      if (!g) return send(ws, { type: 'error', text: 'Game not found. Check the code.' });
      let p = [...g.players.values()].find((x) => m.token && x.token === m.token);
      if (!p) {
        if (g.phase !== 'lobby') return send(ws, { type: 'error', text: 'That game already started.' });
        if (g.players.size >= 30) return send(ws, { type: 'error', text: 'Game is full.' });
        p = addPlayer(g, m.name, m.token);
      }
      game = g; me = p; p.ws = ws;
      send(ws, { type: 'joined', code: g.code, token: p.token });
      return pushState(g);
    }
    if (!game || !me) return;
    const g = game;
    switch (m.type) {
      case 'pos':
        if (Number.isFinite(+m.lat) && Number.isFinite(+m.lng)) {
          me.pos = { lat: +m.lat, lng: +m.lng, acc: +m.acc || 0 };
          if (g.phase === 'lobby') pushState(g);
        }
        break;
      case 'team':
        if (g.phase === 'lobby' && (m.id === me.id || g.hostId === me.id)) {
          const p = g.players.get(m.id);
          if (p && (m.team === 'hunter' || m.team === 'runner')) { p.team = m.team; pushState(g); }
        }
        break;
      case 'zone':
        if (g.phase === 'lobby' && g.hostId === me.id) {
          g.settings.zone = m.zone && Number.isFinite(+m.zone.lat)
            ? { lat: +m.zone.lat, lng: +m.zone.lng, radius: clamp(m.zone.radius, 30, 20000, 300) } : null;
          pushState(g);
        }
        break;
      case 'settings':
        if (g.phase === 'lobby' && g.hostId === me.id) {
          const s = g.settings, n = m.settings || {};
          s.mode = n.mode === 'infection' ? 'infection' : 'classic';
          s.roundMin = clamp(n.roundMin, 1, 120, s.roundMin);
          s.headStartMin = clamp(n.headStartMin, 0, 30, s.headStartMin);
          s.pingMin = clamp(n.pingMin, 0, 30, s.pingMin);
          s.shrink = !!n.shrink;
          pushState(g);
        }
        break;
      case 'start': {
        if (g.phase !== 'lobby' || g.hostId !== me.id) break;
        const ps = [...g.players.values()];
        if (!ps.some((p) => p.team === 'hunter') || !ps.some((p) => p.team === 'runner'))
          return send(ws, { type: 'error', text: 'Need at least one hunter and one runner.' });
        g.startedAt = now();
        g.roundEnds = g.startedAt + (g.settings.headStartMin + g.settings.roundMin) * 60_000;
        g.headStartEnds = g.startedAt + g.settings.headStartMin * 60_000;
        g.phase = g.settings.headStartMin > 0 ? 'headstart' : 'running';
        g.lastPing = now();
        if (g.phase === 'running' && g.settings.pingMin) takePings(g);
        addEvent(g, g.phase === 'headstart' ? 'Runners — go hide!' : 'Game on!', 'go');
        broadcast(g, { type: 'vibrate' });
        pushState(g);
        break;
      }
      case 'tag': // hunter claims a tag on a runner nearby
        if (g.phase === 'running' && me.team === 'hunter') {
          const r = g.players.get(m.id);
          if (!r || r.team !== 'runner' || r.status !== 'active') break;
          if (me.pos && r.pos && dist(me.pos, r.pos) > TAG_RANGE_M + (me.pos.acc || 0) + (r.pos.acc || 0))
            return send(ws, { type: 'toast', text: 'Too far from that runner to tag.' });
          r.pendingTag = { by: me.id, byName: me.name };
          send(r.ws, { type: 'vibrate' });
          send(ws, { type: 'toast', text: `Waiting for ${r.name} to confirm…` });
          pushState(g);
        }
        break;
      case 'confirmTag':
        if (g.phase === 'running' && me.pendingTag) {
          const h = g.players.get(me.pendingTag.by);
          if (m.accept && h) tagPlayer(g, me, h); else me.pendingTag = null;
          pushState(g);
        }
        break;
      case 'selfTag': // runner taps "I got tagged"
        if (g.phase === 'running' && me.team === 'runner' && me.status === 'active') {
          const hunters = [...g.players.values()].filter((p) => p.team === 'hunter');
          const near = hunters.filter((h) => h.pos && me.pos).sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0] || hunters[0];
          if (near) tagPlayer(g, me, near);
          pushState(g);
        }
        break;
      case 'end':
        if (g.hostId === me.id && g.phase !== 'ended') { endGame(g, 'none', 'Host ended the game.'); pushState(g); }
        break;
    }
  });
  ws.on('close', () => {
    if (me && me.ws === ws) { me.ws = null; if (game) { if (game.phase === 'lobby') pushState(game); } }
  });
});

function addPlayer(g, name, token) {
  const id = rid(8);
  const p = {
    id, token: token || crypto.randomUUID(), name: String(name || 'Player').slice(0, 16).trim() || 'Player',
    team: 'runner', status: 'active', pos: null, outSince: null, ws: null, pendingTag: null,
    color: COLORS[g.players.size % COLORS.length],
  };
  g.players.set(id, p);
  return p;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Skedaddle running on :${PORT}`));
