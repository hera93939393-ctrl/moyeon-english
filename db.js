// ============================================================
//  예약 / 커리큘럼 데이터 저장소
//  ------------------------------------------------------------
//  - .env 에 DATABASE_URL(Neon 등 클라우드 Postgres 주소)이 있으면 → Postgres 사용
//  - 없으면                                                     → 로컬 SQLite 파일 사용
//  로컬 개발은 지금처럼 그대로 되고, 배포할 땐 DATABASE_URL만 넣으면
//  예약 데이터가 서버 재시작에도 사라지지 않는 클라우드 DB로 바뀝니다.
// ============================================================
const path = require('path');

const useCloud = !!process.env.DATABASE_URL;
const DB_MODE = useCloud ? 'PostgreSQL (클라우드)' : 'SQLite (로컬)';

let pool;
let sqlite;

if (useCloud) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  const { DatabaseSync } = require('node:sqlite');
  sqlite = new DatabaseSync(path.join(__dirname, 'data', 'reservations.db'));
}

async function initDb() {
  if (useCloud) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        student_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        student_grade TEXT NOT NULL,
        subject TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        slot_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        manage_token TEXT NOT NULL UNIQUE,
        privacy_agreed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reminder_status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_phone ON reservations(phone) WHERE status = 'confirmed'`);
    await pool.query(`DELETE FROM reservations WHERE created_at <= NOW() - INTERVAL '30 days'`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS curriculum_docs (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        student_grade TEXT NOT NULL,
        subject TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        slot_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        manage_token TEXT NOT NULL UNIQUE,
        privacy_agreed_at TEXT NOT NULL,
        reminder_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_phone ON reservations(phone) WHERE status = 'confirmed'`);
    sqlite.prepare(`DELETE FROM reservations WHERE created_at <= datetime('now', '-30 days')`).run();
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS curriculum_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
}

// 유니크 제약(중복 연락처) 위반인지 DB 종류에 맞게 확인합니다.
function isUniqueViolation(error) {
  return useCloud ? error.code === '23505' : String(error.message).includes('UNIQUE');
}

async function getSlotCounts(ignoreId = 0) {
  if (useCloud) {
    const res = await pool.query(
      `SELECT slot_id AS "slotId", COUNT(*) AS count FROM reservations WHERE status = 'confirmed' AND id != $1 GROUP BY slot_id`,
      [ignoreId]
    );
    return res.rows.map((r) => [r.slotId, Number(r.count)]);
  }
  return sqlite
    .prepare(`SELECT slot_id AS slotId, COUNT(*) AS count FROM reservations WHERE status = 'confirmed' AND id != ? GROUP BY slot_id`)
    .all(ignoreId)
    .map((r) => [r.slotId, r.count]);
}

async function countConfirmed() {
  if (useCloud) {
    const res = await pool.query(`SELECT COUNT(*) AS count FROM reservations WHERE status = 'confirmed'`);
    return Number(res.rows[0].count);
  }
  return sqlite.prepare(`SELECT COUNT(*) AS count FROM reservations WHERE status = 'confirmed'`).get().count;
}

async function createReservation({ studentName, phone, studentGrade, school, slotId, note, manageToken }) {
  if (useCloud) {
    const res = await pool.query(
      `INSERT INTO reservations (student_name, phone, student_grade, subject, reason, slot_id, note, manage_token, privacy_agreed_at)
       VALUES ($1,$2,$3,$4,'',$5,$6,$7,NOW()) RETURNING id`,
      [studentName, phone, studentGrade, school, slotId, note, manageToken]
    );
    return res.rows[0].id;
  }
  const result = sqlite
    .prepare(
      `INSERT INTO reservations (student_name, phone, student_grade, subject, reason, slot_id, note, manage_token, privacy_agreed_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, datetime('now'))`
    )
    .run(studentName, phone, studentGrade, school, slotId, note, manageToken);
  return Number(result.lastInsertRowid);
}

async function findConfirmedByToken(id, token) {
  if (useCloud) {
    const res = await pool.query(
      `SELECT * FROM reservations WHERE id = $1 AND manage_token = $2 AND status = 'confirmed'`,
      [id, token]
    );
    return res.rows[0];
  }
  return sqlite
    .prepare(`SELECT * FROM reservations WHERE id = ? AND manage_token = ? AND status = 'confirmed'`)
    .get(id, token);
}

async function updateReservation(id, { studentName, phone, studentGrade, school, slotId, note }) {
  if (useCloud) {
    await pool.query(
      `UPDATE reservations SET student_name=$1, phone=$2, student_grade=$3, subject=$4, reason='', slot_id=$5, note=$6, reminder_status='pending' WHERE id=$7`,
      [studentName, phone, studentGrade, school, slotId, note, id]
    );
    return;
  }
  sqlite
    .prepare(`UPDATE reservations SET student_name=?, phone=?, student_grade=?, subject=?, reason='', slot_id=?, note=?, reminder_status='pending' WHERE id=?`)
    .run(studentName, phone, studentGrade, school, slotId, note, id);
}

async function cancelReservation(id, token) {
  if (useCloud) {
    const res = await pool.query(
      `UPDATE reservations SET status='cancelled' WHERE id=$1 AND manage_token=$2 AND status='confirmed'`,
      [id, token]
    );
    return res.rowCount > 0;
  }
  const result = sqlite
    .prepare(`UPDATE reservations SET status='cancelled' WHERE id=? AND manage_token=? AND status='confirmed'`)
    .run(id, token);
  return result.changes > 0;
}

async function listReservations() {
  if (useCloud) {
    const res = await pool.query(`
      SELECT id, student_name AS "studentName", phone, student_grade AS "studentGrade",
             subject AS school, slot_id AS "slotId", note, status, reminder_status AS "reminderStatus", created_at AS "createdAt"
      FROM reservations ORDER BY id DESC
    `);
    return res.rows;
  }
  return sqlite
    .prepare(
      `SELECT id, student_name AS studentName, phone, student_grade AS studentGrade,
              subject AS school, slot_id AS slotId, note, status, reminder_status AS reminderStatus, created_at AS createdAt
       FROM reservations ORDER BY id DESC`
    )
    .all();
}

async function listReminderDue(tomorrowPrefix) {
  if (useCloud) {
    const res = await pool.query(
      `SELECT id, student_name AS "studentName", phone, slot_id AS "slotId" FROM reservations WHERE status='confirmed' AND reminder_status='pending' AND slot_id LIKE $1`,
      [`${tomorrowPrefix}|%`]
    );
    return res.rows;
  }
  return sqlite
    .prepare(`SELECT id, student_name AS studentName, phone, slot_id AS slotId FROM reservations WHERE status='confirmed' AND reminder_status='pending' AND slot_id LIKE ?`)
    .all(`${tomorrowPrefix}|%`);
}

async function getCurriculumDoc() {
  if (useCloud) {
    const res = await pool.query(`SELECT filename, content, uploaded_at AS "uploadedAt" FROM curriculum_docs ORDER BY id DESC LIMIT 1`);
    return res.rows[0];
  }
  return sqlite.prepare(`SELECT filename, content, uploaded_at AS uploadedAt FROM curriculum_docs ORDER BY id DESC LIMIT 1`).get();
}

async function saveCurriculumDoc(filename, content) {
  if (useCloud) {
    await pool.query(`DELETE FROM curriculum_docs`);
    await pool.query(`INSERT INTO curriculum_docs (filename, content) VALUES ($1, $2)`, [filename, content]);
    return;
  }
  sqlite.exec(`DELETE FROM curriculum_docs`);
  sqlite.prepare(`INSERT INTO curriculum_docs (filename, content) VALUES (?, ?)`).run(filename, content);
}

module.exports = {
  DB_MODE,
  initDb,
  isUniqueViolation,
  getSlotCounts,
  countConfirmed,
  createReservation,
  findConfirmedByToken,
  updateReservation,
  cancelReservation,
  listReservations,
  listReminderDue,
  getCurriculumDoc,
  saveCurriculumDoc,
};
