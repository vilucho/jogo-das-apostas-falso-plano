import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { db } from "./db.js";
import { calculateLives, missingPlayerSelections, scorePick } from "./game-logic.js";
import { createSession, hashPin, normalizeName, readSession, verifyPin } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const adminName = process.env.ADMIN_NAME || "Vilucho";
const adminPin = process.env.ADMIN_PIN;
const loginAttempts = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/csv", limit: "2mb" }));
app.use(cookieParser());
app.use(express.static("public"));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const currentUser = (req) => {
  const session = readSession(req.cookies.fp_session);
  return session ? db.prepare("SELECT id,name,role,active FROM users WHERE id=? AND active=1").get(session.id) : null;
};
const requireUser = (req, res, next) => {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: "Precisas de entrar." });
  next();
};
const requireAdmin = (req, res, next) => {
  req.user = currentUser(req);
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Acesso reservado à administração." });
  next();
};
const nowIso = () => new Date().toISOString();

async function ensureAdmin(name, pin) {
  if (!adminPin || normalizeName(name) !== normalizeName(adminName) || pin !== adminPin) return null;
  let user = db.prepare("SELECT * FROM users WHERE normalized_name=?").get(normalizeName(adminName));
  if (!user) {
    const credentials = await hashPin(adminPin);
    const info = db.prepare("INSERT INTO users(name,normalized_name,pin_salt,pin_hash,role) VALUES(?,?,?,?, 'admin')")
      .run(adminName, normalizeName(adminName), credentials.salt, credentials.hash);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  }
  return user;
}

app.post("/api/auth", wrap(async (req, res) => {
  const attemptKey = req.ip || "unknown";
  const attempts = (loginAttempts.get(attemptKey) || []).filter(time => time > Date.now() - 15 * 60_000);
  if (attempts.length >= 20) return res.status(429).json({ error: "Demasiadas tentativas. Espera alguns minutos." });
  attempts.push(Date.now());
  loginAttempts.set(attemptKey, attempts);
  const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
  const pin = String(req.body.pin || "");
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: "Escreve um nome entre 2 e 40 caracteres." });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "O PIN deve ter entre 4 e 8 algarismos." });
  let user = await ensureAdmin(name, pin);
  if (!user) user = db.prepare("SELECT * FROM users WHERE normalized_name=?").get(normalizeName(name));
  if (user) {
    if (!user.active || !(await verifyPin(pin, user.pin_salt, user.pin_hash))) {
      return res.status(401).json({ error: "Este nome já está registado ou o PIN está incorreto." });
    }
  } else {
    const credentials = await hashPin(pin);
    const info = db.prepare("INSERT INTO users(name,normalized_name,pin_salt,pin_hash) VALUES(?,?,?,?)")
      .run(name, normalizeName(name), credentials.salt, credentials.hash);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  }
  res.cookie("fp_session", createSession(user), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 864e5 });
  loginAttempts.delete(attemptKey);
  res.json({ user: { id: user.id, name: user.name, role: user.role } });
}));

app.post("/api/logout", (req, res) => { res.clearCookie("fp_session"); res.json({ ok: true }); });
app.get("/api/me", (req, res) => { const user = currentUser(req); res.json({ user }); });

function evaluateClosures() {
  const stages = db.prepare("SELECT * FROM stages WHERE status='open'").all();
  const now = Date.now();
  const close = db.prepare("UPDATE stages SET status='closed',closed_at=?,close_reason=? WHERE id=? AND status='open'");
  for (const stage of stages) {
    if (stage.manual_closes_at && new Date(stage.manual_closes_at).getTime() <= now) close.run(nowIso(), "manual", stage.id);
    else if (stage.detected_km != null && stage.detected_km <= stage.distance_threshold) close.run(nowIso(), "quilometragem", stage.id);
    else if (stage.safety_closes_at && new Date(stage.safety_closes_at).getTime() <= now) close.run(nowIso(), "hora de segurança", stage.id);
  }
}

app.get("/api/home", requireUser, (req, res) => {
  evaluateClosures();
  const competitions = db.prepare(`SELECT c.*, EXISTS(SELECT 1 FROM participants p WHERE p.competition_id=c.id AND p.user_id=?) joined,
    (SELECT COUNT(*) FROM participants p WHERE p.competition_id=c.id) participant_count
    FROM competitions c ORDER BY c.year DESC,c.id DESC`).all(req.user.id);
  res.json({ user: req.user, competitions });
});

app.post("/api/competitions/:id/join", requireUser, (req, res) => {
  const competition = db.prepare("SELECT * FROM competitions WHERE id=?").get(req.params.id);
  if (!competition?.registration_open) return res.status(400).json({ error: "As inscrições estão fechadas." });
  db.prepare("INSERT OR IGNORE INTO participants(competition_id,user_id) VALUES(?,?)").run(competition.id, req.user.id);
  res.json({ ok: true });
});

app.get("/api/competitions/:id", requireUser, (req, res) => {
  evaluateClosures();
  const competition = db.prepare("SELECT * FROM competitions WHERE id=?").get(req.params.id);
  if (!competition) return res.status(404).json({ error: "Competição não encontrada." });
  const joined = !!db.prepare("SELECT 1 FROM participants WHERE competition_id=? AND user_id=?").get(competition.id, req.user.id);
  const stages = db.prepare(`SELECT s.*,
    (SELECT COUNT(*) FROM bets b WHERE b.stage_id=s.id AND b.user_id=?) bet_count
    FROM stages s WHERE competition_id=? ORDER BY number`).all(req.user.id, competition.id);
  const leaderboard = buildLeaderboard(competition.id);
  res.json({ competition, joined, stages, leaderboard });
});

app.get("/api/stages/:id", requireUser, (req, res) => {
  evaluateClosures();
  const stage = db.prepare("SELECT s.*,c.name competition_name FROM stages s JOIN competitions c ON c.id=s.competition_id WHERE s.id=?").get(req.params.id);
  if (!stage) return res.status(404).json({ error: "Etapa não encontrada." });
  const joined = db.prepare("SELECT 1 FROM participants WHERE competition_id=? AND user_id=?").get(stage.competition_id, req.user.id);
  if (!joined && req.user.role !== "admin") return res.status(403).json({ error: "Não estás inscrito nesta competição." });
  const riders = db.prepare("SELECT id,name,team FROM riders WHERE competition_id=? ORDER BY name").all(stage.competition_id);
  const myBets = db.prepare("SELECT slot,rider_id,submitted_at FROM bets WHERE stage_id=? AND user_id=? ORDER BY slot").all(stage.id, req.user.id);
  let revealed = [];
  if (stage.status !== "open") {
    revealed = db.prepare(`SELECT u.name player,b.slot,r.name rider,r.team,b.automatic,
      CASE WHEN re.position=1 THEN CASE b.slot WHEN 1 THEN -200 WHEN 2 THEN -100 ELSE -50 END ELSE re.position END score
      FROM bets b JOIN users u ON u.id=b.user_id JOIN riders r ON r.id=b.rider_id
      LEFT JOIN results re ON re.stage_id=b.stage_id AND re.rider_id=b.rider_id
      WHERE b.stage_id=? ORDER BY u.name,b.slot`).all(stage.id);
  }
  const betStatus = db.prepare(`SELECT u.name,COUNT(b.id) bet_count FROM participants p JOIN users u ON u.id=p.user_id
    LEFT JOIN bets b ON b.user_id=u.id AND b.stage_id=? WHERE p.competition_id=? GROUP BY u.id ORDER BY u.name`).all(stage.id, stage.competition_id);
  res.json({ stage, riders, myBets, revealed, betStatus: req.user.role === "admin" ? betStatus : { submitted: betStatus.filter(x => x.bet_count === 3).length, total: betStatus.length } });
});

app.put("/api/stages/:id/bet", requireUser, (req, res) => {
  evaluateClosures();
  const stage = db.prepare("SELECT * FROM stages WHERE id=?").get(req.params.id);
  if (!stage || stage.status !== "open") return res.status(400).json({ error: "As apostas desta etapa estão fechadas." });
  const joined = db.prepare("SELECT 1 FROM participants WHERE competition_id=? AND user_id=?").get(stage.competition_id, req.user.id);
  if (!joined) return res.status(403).json({ error: "Não estás inscrito nesta competição." });
  const choices = Array.isArray(req.body.choices) ? req.body.choices.map(Number) : [];
  if (choices.length !== 3 || new Set(choices).size !== 3) return res.status(400).json({ error: "Escolhe três ciclistas diferentes." });
  const valid = db.prepare(`SELECT COUNT(*) count FROM riders WHERE competition_id=? AND id IN (${choices.map(() => "?").join(",")})`).get(stage.competition_id, ...choices);
  if (valid.count !== 3) return res.status(400).json({ error: "Existe uma escolha inválida." });
  db.transaction(() => {
    db.prepare("DELETE FROM bets WHERE stage_id=? AND user_id=?").run(stage.id, req.user.id);
    const insert = db.prepare("INSERT INTO bets(stage_id,user_id,slot,rider_id) VALUES(?,?,?,?)");
    choices.forEach((riderId, index) => insert.run(stage.id, req.user.id, index + 1, riderId));
  })();
  res.json({ ok: true, submittedAt: nowIso() });
});

app.post("/api/admin/competitions", requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const year = Number(req.body.year);
    const stageCount = Number(req.body.stageCount);
    const firstCloseAt = req.body.firstCloseAt ? new Date(req.body.firstCloseAt) : null;
    const riders = parseCsv(req.body.csv);
    if (!name || !Number.isInteger(year) || !firstCloseAt || Number.isNaN(firstCloseAt.getTime())) throw new Error("Indica o nome, o ano e a data da primeira etapa.");
    if (!Number.isInteger(stageCount) || stageCount < 1 || stageCount > 21) throw new Error("O número de etapas deve ficar entre 1 e 21.");
    const seen = new Set();
    for (const rider of riders) {
      const key = normalizeName(rider.name);
      if (seen.has(key)) throw new Error(`Ciclista repetido: ${rider.name}`);
      seen.add(key);
    }
    let info;
    db.transaction(() => {
      info = db.prepare("INSERT INTO competitions(name,year) VALUES(?,?)").run(name, year);
      const insertStage = db.prepare("INSERT INTO stages(competition_id,number,safety_closes_at,distance_threshold) VALUES(?,?,?,50)");
      for (let number = 1; number <= stageCount; number++) {
        insertStage.run(info.lastInsertRowid, number, new Date(firstCloseAt.getTime() + (number - 1) * 864e5).toISOString());
      }
      const insertRider = db.prepare("INSERT INTO riders(competition_id,name,team,normalized_name) VALUES(?,?,?,?)");
      riders.forEach(rider => insertRider.run(info.lastInsertRowid, rider.name, rider.team, normalizeName(rider.name)));
    })();
    res.json({ id: info.lastInsertRowid, stages: stageCount, riders: riders.length });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/admin/competitions/:id/generate-stages", requireAdmin, (req, res) => {
  const firstCloseAt = req.body.firstCloseAt ? new Date(req.body.firstCloseAt) : null;
  const stageCount = Number(req.body.stageCount);
  if (!firstCloseAt || Number.isNaN(firstCloseAt.getTime())) return res.status(400).json({ error: "Indica a data da primeira etapa." });
  if (!Number.isInteger(stageCount) || stageCount < 1 || stageCount > 21) return res.status(400).json({ error: "O número de etapas deve ficar entre 1 e 21." });
  const insert = db.prepare("INSERT OR IGNORE INTO stages(competition_id,number,safety_closes_at,distance_threshold) VALUES(?,?,?,50)");
  db.transaction(() => {
    for (let number = 1; number <= stageCount; number++) {
      insert.run(req.params.id, number, new Date(firstCloseAt.getTime() + (number - 1) * 864e5).toISOString());
    }
  })();
  res.json({ ok: true, count: db.prepare("SELECT COUNT(*) count FROM stages WHERE competition_id=?").get(req.params.id).count });
});

app.patch("/api/admin/competitions/:id", requireAdmin, (req, res) => {
  const allowed = ["registration_open", "status"];
  const entries = Object.entries(req.body).filter(([key]) => allowed.includes(key));
  if (!entries.length) return res.status(400).json({ error: "Nada para alterar." });
  db.prepare(`UPDATE competitions SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`).run(...entries.map(([,value]) => value), req.params.id);
  res.json({ ok: true });
});

function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("O CSV não tem ciclistas.");
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = lines.shift().split(delimiter).map(x => normalizeName(x));
  const riderIndex = headers.findIndex(x => ["ciclista", "nome", "rider"].includes(x));
  const teamIndex = headers.findIndex(x => ["equipa", "team"].includes(x));
  if (riderIndex < 0 || teamIndex < 0) throw new Error("O CSV precisa das colunas ciclista e equipa.");
  return lines.map(line => {
    const cells = line.split(delimiter).map(x => x.trim().replace(/^"|"$/g, ""));
    return { name: cells[riderIndex], team: cells[teamIndex] };
  }).filter(x => x.name && x.team);
}

app.post("/api/admin/competitions/:id/riders", requireAdmin, (req, res) => {
  try {
    const riders = parseCsv(req.body);
    const seen = new Set();
    for (const rider of riders) {
      const key = normalizeName(rider.name);
      if (seen.has(key)) return res.status(400).json({ error: `Ciclista repetido: ${rider.name}` });
      seen.add(key);
    }
    db.transaction(() => {
      db.prepare("DELETE FROM riders WHERE competition_id=? AND id NOT IN (SELECT rider_id FROM bets)").run(req.params.id);
      const upsert = db.prepare(`INSERT INTO riders(competition_id,name,team,normalized_name) VALUES(?,?,?,?)
        ON CONFLICT(competition_id,normalized_name) DO UPDATE SET name=excluded.name,team=excluded.team`);
      riders.forEach(r => upsert.run(req.params.id, r.name, r.team, normalizeName(r.name)));
    })();
    res.json({ count: riders.length });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/admin/competitions/:id/stages", requireAdmin, (req, res) => {
  const number = Number(req.body.number);
  if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: "Número de etapa inválido." });
  const info = db.prepare(`INSERT INTO stages(competition_id,number,title,safety_closes_at,distance_threshold,live_url)
    VALUES(?,?,?,?,?,?)`).run(req.params.id, number, String(req.body.title || ""), req.body.safetyClosesAt || null, Number(req.body.distanceThreshold || 50), req.body.liveUrl || null);
  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/admin/stages/:id", requireAdmin, (req, res) => {
  const stage = db.prepare("SELECT * FROM stages WHERE id=?").get(req.params.id);
  if (!stage) return res.status(404).json({ error: "Etapa não encontrada." });
  if (stage.status !== "open") return res.status(400).json({ error: "Só podes editar uma etapa ainda aberta." });
  const closesAt = req.body.safetyClosesAt ? new Date(req.body.safetyClosesAt) : null;
  if (!closesAt || Number.isNaN(closesAt.getTime())) return res.status(400).json({ error: "Data ou hora inválida." });
  db.prepare("UPDATE stages SET title=?,safety_closes_at=?,distance_threshold=? WHERE id=?")
    .run(String(req.body.title || ""), closesAt.toISOString(), Number(req.body.distanceThreshold || 50), stage.id);
  res.json({ ok: true });
});

app.post("/api/admin/stages/:id/close", requireAdmin, (req, res) => {
  const minutes = Math.max(0, Number(req.body.minutes || 0));
  if (minutes === 0) db.prepare("UPDATE stages SET status='closed',closed_at=?,close_reason='manual' WHERE id=? AND status='open'").run(nowIso(), req.params.id);
  else db.prepare("UPDATE stages SET manual_closes_at=? WHERE id=? AND status='open'").run(new Date(Date.now() + minutes * 60000).toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/stages/:id/distance", requireAdmin, (req, res) => {
  const km = Number(req.body.km);
  if (!Number.isFinite(km) || km < 0) return res.status(400).json({ error: "Distância inválida." });
  db.prepare("UPDATE stages SET detected_km=? WHERE id=? AND status='open'").run(km, req.params.id);
  evaluateClosures();
  res.json({ ok: true });
});

app.get("/api/admin/stages/:id/chosen", requireAdmin, (req, res) => {
  const stage = db.prepare("SELECT * FROM stages WHERE id=?").get(req.params.id);
  if (!stage || stage.status === "open") return res.status(400).json({ error: "A etapa ainda está aberta." });
  const riders = db.prepare(`SELECT DISTINCT r.id,r.name,r.team,re.position FROM bets b JOIN riders r ON r.id=b.rider_id
    LEFT JOIN results re ON re.stage_id=b.stage_id AND re.rider_id=r.id WHERE b.stage_id=? ORDER BY r.name`).all(stage.id);
  res.json({ stage, riders });
});

app.post("/api/admin/stages/:id/results", requireAdmin, (req, res) => {
  const stage = db.prepare("SELECT * FROM stages WHERE id=?").get(req.params.id);
  if (!stage || stage.status === "open") return res.status(400).json({ error: "Fecha primeiro a etapa." });
  const entries = Array.isArray(req.body.results) ? req.body.results : [];
  const chosenIds = db.prepare("SELECT DISTINCT rider_id FROM bets WHERE stage_id=?").all(stage.id).map(x => x.rider_id);
  const received = new Map(entries.map(x => [Number(x.riderId), Number(x.position)]));
  if (chosenIds.some(id => !Number.isInteger(received.get(id)) || received.get(id) < 1)) return res.status(400).json({ error: "Preenche o resultado de todos os ciclistas escolhidos." });
  db.transaction(() => {
    const upsert = db.prepare("INSERT INTO results(stage_id,rider_id,position) VALUES(?,?,?) ON CONFLICT(stage_id,rider_id) DO UPDATE SET position=excluded.position");
    received.forEach((position, riderId) => upsert.run(stage.id, riderId, position));
    assignMissingBets(stage);
    db.prepare("UPDATE stages SET status='calculated' WHERE id=?").run(stage.id);
  })();
  res.json({ ok: true });
});

function assignMissingBets(stage) {
  const resultRows = db.prepare(`SELECT DISTINCT b.rider_id,re.position FROM bets b JOIN results re ON re.stage_id=b.stage_id AND re.rider_id=b.rider_id
    WHERE b.stage_id=? AND b.automatic=0`).all(stage.id);
  const fallback = missingPlayerSelections(new Map(resultRows.map(row => [row.rider_id, row.position])));
  const missing = db.prepare(`SELECT p.user_id FROM participants p LEFT JOIN bets b ON b.user_id=p.user_id AND b.stage_id=?
    WHERE p.competition_id=? GROUP BY p.user_id HAVING COUNT(b.id)=0`).all(stage.id, stage.competition_id);
  const insert = db.prepare("INSERT INTO bets(stage_id,user_id,slot,rider_id,automatic) VALUES(?,?,?,?,1)");
  for (const player of missing) fallback.forEach(choice => insert.run(stage.id, player.user_id, choice.slot, choice.riderId));
}

app.post("/api/admin/stages/:id/cancel", requireAdmin, (req, res) => {
  db.prepare("UPDATE stages SET status='cancelled',closed_at=COALESCE(closed_at,?),close_reason='etapa cancelada' WHERE id=?").run(nowIso(), req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-pin", requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET active=0 WHERE id=? AND role='player'").run(req.params.id);
  res.json({ ok: true, note: "Conta desativada. O administrador pode reativá-la após confirmar a identidade." });
});

function buildLeaderboard(competitionId) {
  const players = db.prepare(`SELECT u.id,u.name FROM participants p JOIN users u ON u.id=p.user_id WHERE p.competition_id=? ORDER BY u.name`).all(competitionId);
  const rows = players.map(player => {
    const picks = db.prepare(`SELECT b.slot,re.position FROM bets b JOIN stages s ON s.id=b.stage_id JOIN results re ON re.stage_id=b.stage_id AND re.rider_id=b.rider_id
      WHERE b.user_id=? AND s.competition_id=? AND s.status='calculated'`).all(player.id, competitionId);
    const scores = picks.map(pick => scorePick(pick.slot, pick.position));
    return { ...player, ...calculateLives(scores), choices: scores.length };
  }).sort((a, b) => a.total - b.total || a.name.localeCompare(b.name, "pt"));
  const leader = rows[0]?.total ?? 0;
  let previousTotal = null;
  let previousRank = 0;
  return rows.map((row, index) => {
    const rank = row.total === previousTotal ? previousRank : index + 1;
    previousTotal = row.total;
    previousRank = rank;
    return { ...row, rank, difference: row.total - leader };
  });
}

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Algo correu mal. Tenta novamente." });
});

setInterval(evaluateClosures, 15000).unref();
app.listen(port, () => console.log(`Jogo das Apostas em http://localhost:${port}`));
