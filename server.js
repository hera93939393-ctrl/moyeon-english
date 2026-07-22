const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const academy = require('./data/academy');
const { notifyOwner } = require('./sms');
const aiChat = require('./ai-chat');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const port = Number(process.env.PORT) || 3000;
const capacity = 30;
const slotCapacity = 2;
const db = new DatabaseSync(path.join(__dirname, 'data', 'reservations.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    student_grade TEXT NOT NULL,
    subject TEXT NOT NULL,
    reason TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed',
    manage_token TEXT NOT NULL UNIQUE,
    privacy_agreed_at TEXT NOT NULL,
    reminder_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_phone ON reservations(phone) WHERE status = 'confirmed'`);
db.prepare(`DELETE FROM reservations WHERE created_at <= datetime('now', '-30 days')`).run();

// 원장님이 업로드한 커리큘럼 자료 (AI 챗봇이 답변할 때 참고 자료로 사용)
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

function getCurriculumDoc() {
  return db.prepare(`SELECT filename, content, uploaded_at AS uploadedAt FROM curriculum_docs ORDER BY id DESC LIMIT 1`).get();
}

const gradeOptions = ['초1','초2','초3','초4','초5','초6','중1','중2','중3'];
const academyPlace = `${academy.name} 상담실 · ${academy.address}`;
const materials = '필기구, 학생이 최근 푼 영어 문제집 또는 성적표(있는 경우)';
const resultGuide = '테스트 직후 간단히 구두 안내하고, 상세 결과는 당일 보호자 연락처로 안내합니다.';

// 관리자 화면(예약 목록 등 개인정보 포함)은 아이디/비밀번호로 보호합니다.
// .env 에 ADMIN_USER / ADMIN_PASSWORD 를 설정하세요. 설정 전에는 접근 자체를 막습니다.
function requireAdminAuth(req, res, next) {
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) {
    return res.status(503).send('관리자 계정이 설정되지 않았습니다. .env 에 ADMIN_USER, ADMIN_PASSWORD 를 설정해 주세요.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  const decoded = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [user, password] = decoded.split(':');
  if (user === adminUser && password === adminPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="moyeon-admin"');
  return res.status(401).send('관리자 인증이 필요합니다.');
}

function getSlots(ignoreId = 0) {
  const slots = [];
  const counts = new Map(
    db.prepare(`SELECT slot_id AS slotId, COUNT(*) AS count FROM reservations WHERE status = 'confirmed' AND id != ? GROUP BY slot_id`).all(ignoreId)
      .map(item => [item.slotId, item.count])
  );
  for (let offset = 1; offset <= 365; offset += 1) {
    const date = new Date(Date.now() + offset * 86400000);
    const dateId = date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(date);
    if (weekday === '일') continue;
    for (const time of ['16:00', '17:30', '19:00']) {
      const id = `${dateId}|${time}`;
      const count = counts.get(id) || 0;
      slots.push({ id, date: dateId, time, label: `${dateId.slice(5).replace('-', '/')}(${weekday}) ${time}`, remaining: Math.max(0, slotCapacity - count), full: count >= slotCapacity });
    }
  }
  return slots;
}

function validateReservation(body, ignoreId = 0) {
  const data = {
    studentName: String(body?.studentName || '').trim(),
    phone: String(body?.phone || '').replace(/[^0-9]/g, ''),
    studentGrade: String(body?.studentGrade || '').trim(),
    school: String(body?.school || '').trim(),
    slotId: String(body?.slotId || '').trim(),
    note: String(body?.note || '').trim(),
    privacyAgreed: body?.privacyAgreed === true
  };
  if (data.studentName.length < 2 || data.studentName.length > 30) return { error: '학생 이름을 2~30자로 입력해 주세요.' };
  if (!/^01[016789][0-9]{7,8}$/.test(data.phone)) return { error: '보호자 휴대전화 번호를 정확히 입력해 주세요.' };
  if (!gradeOptions.includes(data.studentGrade)) return { error: '학생 학년을 선택해 주세요.' };
  if (data.school.length < 2 || data.school.length > 40) return { error: '학교 이름을 2~40자로 입력해 주세요.' };
  const slot = getSlots(ignoreId).find(item => item.id === data.slotId);
  if (!slot || slot.full) return { error: '선택한 시간은 마감되었거나 예약할 수 없어요. 다른 시간을 골라주세요.' };
  if (!data.privacyAgreed) return { error: '개인정보 수집·이용에 동의해 주세요.' };
  if (data.note.length > 300) return { error: '상담 내용은 300자 이하로 입력해 주세요.' };
  return { data, slot };
}

app.use(express.json());
// 정적 파일보다 먼저 등록해서, admin.html 은 항상 인증을 거치도록 합니다.
app.get('/admin.html', requireAdminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/academy', (_req, res) => {
  const { answers, ...publicInfo } = academy;
  res.json(publicInfo);
});
app.post('/api/chat', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const key = String(req.body?.key || '').trim();

  // 빠른 버튼 클릭은 미리 정해둔 답변을 바로 반환 (AI 호출 없이 즉시, 무료)
  if (key && academy.answers[key]) {
    return res.json({ answer: academy.answers[key], mode: 'keyword' });
  }

  // 자유 질문은 AI가 설정되어 있으면 AI로 답변 (업로드된 커리큘럼 자료도 참고)
  if (aiChat.isConfigured && question) {
    try {
      const curriculumDoc = getCurriculumDoc();
      const aiAnswer = await aiChat.getAnswer({ question, academy, curriculumText: curriculumDoc?.content });
      if (aiAnswer) return res.json({ answer: aiAnswer, mode: 'ai' });
    } catch (err) {
      console.error('[AI 답변 실패, 키워드 방식으로 대체]', err.message);
    }
  }

  // AI 미설정이거나 실패했을 때의 대체 방식(키워드 매칭)
  const rules = [
    ['curriculum', /커리|수업|과정/], ['level', /레벨|테스트/],
    ['schedule', /시간|시간표/], ['shuttle', /셔틀|버스/],
    ['tuition', /수강료|비용|얼마|가격/], ['elementary', /초등/],
    ['middle', /중등|내신/], ['discount', /할인|이벤트|행사/]
  ];
  const matched = rules.find(([, regex]) => regex.test(question))?.[0];
  const fallback = '수강료, 시간표, 레벨 테스트, 셔틀처럼 궁금한 내용을 조금 더 구체적으로 알려주세요.';
  res.json({ answer: matched ? academy.answers[matched] : fallback, mode: 'keyword' });
});

// 커리큘럼 자료 업로드 (원장님 전용 - 관리자 인증 필요)
app.post('/api/curriculum', requireAdminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일을 선택해 주세요.' });
  const { originalname, buffer, mimetype } = req.file;
  let text = '';
  try {
    if (mimetype === 'application/pdf' || /\.pdf$/i.test(originalname)) {
      text = (await pdfParse(buffer)).text;
    } else {
      text = buffer.toString('utf8');
    }
  } catch (err) {
    return res.status(400).json({ error: '파일에서 글자를 읽지 못했어요. PDF 또는 텍스트(.txt) 파일만 지원해요.' });
  }
  text = text.trim();
  if (!text) return res.status(400).json({ error: '파일에서 내용을 찾지 못했어요.' });
  db.exec(`DELETE FROM curriculum_docs`);
  db.prepare(`INSERT INTO curriculum_docs (filename, content) VALUES (?, ?)`).run(originalname, text);
  res.json({ message: '커리큘럼 자료가 업로드되었습니다.', filename: originalname, length: text.length });
});

// 현재 업로드된 커리큘럼 자료 정보 확인 (원장님 전용)
app.get('/api/curriculum', requireAdminAuth, (_req, res) => {
  const doc = getCurriculumDoc();
  res.json({
    document: doc ? { filename: doc.filename, uploadedAt: doc.uploadedAt, length: doc.content.length } : null,
    aiEnabled: aiChat.isConfigured,
  });
});

app.get('/api/reservations/status', (_req, res) => {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM reservations WHERE status = 'confirmed'`).get();
  res.json({ capacity, reserved: count, remaining: Math.max(0, capacity - count), full: count >= capacity });
});

app.get('/api/reservations/slots', (_req, res) => res.json({ slots: getSlots() }));

app.post('/api/reservations', (req, res) => {
  const validated = validateReservation(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const { data, slot } = validated;
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM reservations WHERE status = 'confirmed'`).get();
  if (count >= capacity) return res.status(409).json({ error: '현재 상담 예약이 마감되었어요. 학원으로 문의해 주세요.' });
  try {
    const manageToken = randomUUID();
    const result = db.prepare(`
      INSERT INTO reservations (student_name, phone, student_grade, subject, reason, slot_id, note, manage_token, privacy_agreed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(data.studentName, data.phone, data.studentGrade, data.school, '', data.slotId, data.note, manageToken);
    console.log(`[새 레벨 테스트 예약] ${data.studentName} / ${data.studentGrade} / ${slot.label}`);
    notifyOwner(
      `[모연 English] 레벨테스트 예약 접수\n학생: ${data.studentName} (${data.studentGrade}, ${data.school})\n일정: ${slot.label}\n연락처: ${data.phone}`
    ).catch((err) => console.error('[문자 알림 처리 중 오류]', err));
    res.status(201).json({ id: Number(result.lastInsertRowid), manageToken, message: '레벨 테스트 예약이 확정되었습니다!', remaining: capacity - count - 1, confirmation: { studentName: data.studentName, school: data.school, dateTime: slot.label, place: academyPlace, materials, resultGuide, reminder: '예약 하루 전 보호자 연락처로 문자(SMS) 안내 예정' } });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '이미 예약된 연락처예요. 변경은 학원으로 문의해 주세요.' });
    console.error(error);
    res.status(500).json({ error: '예약 저장 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

app.patch('/api/reservations/:id', (req, res) => {
  const id = Number(req.params.id);
  const token = String(req.body?.manageToken || '');
  const current = db.prepare(`SELECT * FROM reservations WHERE id = ? AND manage_token = ? AND status = 'confirmed'`).get(id, token);
  if (!current) return res.status(404).json({ error: '변경할 예약을 찾을 수 없어요.' });
  const validated = validateReservation(req.body, id);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const { data, slot } = validated;
  db.prepare(`UPDATE reservations SET student_name=?, phone=?, student_grade=?, subject=?, reason='', slot_id=?, note=?, reminder_status='pending' WHERE id=?`).run(data.studentName, data.phone, data.studentGrade, data.school, data.slotId, data.note, id);
  res.json({ message: '예약이 변경되었습니다.', confirmation: { studentName: data.studentName, school: data.school, dateTime: slot.label, place: academyPlace, materials, resultGuide } });
});

app.delete('/api/reservations/:id', (req, res) => {
  const id = Number(req.params.id);
  const token = String(req.body?.manageToken || '');
  const result = db.prepare(`UPDATE reservations SET status='cancelled' WHERE id=? AND manage_token=? AND status='confirmed'`).run(id, token);
  if (!result.changes) return res.status(404).json({ error: '취소할 예약을 찾을 수 없어요.' });
  res.json({ message: '예약이 취소되었습니다. 다른 시간으로 언제든 다시 신청해 주세요.' });
});

app.get('/api/reservations', requireAdminAuth, (_req, res) => {
  const reservations = db.prepare(`
    SELECT id, student_name AS studentName, phone, student_grade AS studentGrade,
           subject AS school, slot_id AS slotId, note, status, reminder_status AS reminderStatus, created_at AS createdAt
    FROM reservations ORDER BY id DESC
  `).all();
  res.json({ capacity, reservations });
});

app.get('/api/reminders/due', requireAdminAuth, (_req, res) => {
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const reminders = db.prepare(`SELECT id, student_name AS studentName, phone, slot_id AS slotId FROM reservations WHERE status='confirmed' AND reminder_status='pending' AND slot_id LIKE ?`).all(`${tomorrow}|%`);
  res.json({ channel: '문자(SMS) 발송 서비스 연동 대기', reminders });
});

app.listen(port, () => console.log(`모연 학원 챗봇 서버가 켜졌습니다: http://localhost:${port}`));
