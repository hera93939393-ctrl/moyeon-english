const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const academy = require('./data/academy');
const { notifyOwner } = require('./sms');
const aiChat = require('./ai-chat');
const db = require('./db');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const port = Number(process.env.PORT) || 3000;
const capacity = 30;
const slotCapacity = 2;

// 한글은 "노선은", "하원해요"처럼 단어 끝에 조사가 그대로 붙어서 나오기 때문에,
// 문서의 "노선", "하원은"과 글자 그대로는 다를 수 있습니다. 그래서 뒤에서부터
// 최대 2글자까지 줄여가며 대조해서, 조사가 붙어도 찾아지도록 합니다.
function termMatches(paragraph, term) {
  const minLen = Math.max(2, term.length - 2);
  for (let len = term.length; len >= minLen; len -= 1) {
    if (paragraph.includes(term.slice(0, len))) return true;
  }
  return false;
}

// 업로드된 학원 자료들(커리큘럼·셔틀노선·시간표 등, 여러 개) 전체에서
// 질문과 가장 관련 있는 문단을 찾습니다. (AI 없이, 무료 키워드 검색)
function searchCurriculum(docs, question) {
  if (!docs?.length || !question) return null;
  const terms = question.match(/[가-힣a-zA-Z0-9]{2,}/g) || [];
  if (!terms.length) return null;

  let best = null;
  let bestScore = 0;
  for (const doc of docs) {
    const paragraphs = doc.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      const score = terms.reduce((sum, term) => sum + (termMatches(paragraph, term) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = paragraph;
      }
    }
  }
  return bestScore > 0 ? best : null;
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

async function getSlots(ignoreId = 0) {
  const slots = [];
  const counts = new Map(await db.getSlotCounts(ignoreId));
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

async function validateReservation(body, ignoreId = 0) {
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
  const slot = (await getSlots(ignoreId)).find(item => item.id === data.slotId);
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

  const curriculumDocs = question ? await db.listCurriculumDocs() : [];

  // 자유 질문 1순위: 업로드된 학원 자료들(커리큘럼·셔틀·시간표 등) 전체에서 관련 문단 검색 (무료, AI 아님)
  if (curriculumDocs.length) {
    const found = searchCurriculum(curriculumDocs, question);
    if (found) return res.json({ answer: found, mode: 'document-search' });
  }

  // 자유 질문 2순위: Claude API 키가 설정되어 있을 때만 AI로 답변 (선택 사항, 기본은 꺼짐)
  if (aiChat.isConfigured && question) {
    try {
      const combinedText = curriculumDocs.map((d) => `[${d.filename}]\n${d.content}`).join('\n\n---\n\n');
      const aiAnswer = await aiChat.getAnswer({ question, academy, curriculumText: combinedText || undefined });
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

// 학원 자료 업로드 (커리큘럼·셔틀노선·시간표 등, 여러 개 등록 가능 - 관리자 전용)
app.post('/api/curriculum', requireAdminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일을 선택해 주세요.' });
  const { buffer, mimetype } = req.file;
  // 일부 브라우저는 한글 파일명을 latin1으로 잘못 인코딩해서 보냅니다.
  // 복구를 시도했을 때 깨진 문자(�)가 없으면(=정말 깨져있던 경우) 복구된 이름을 쓰고,
  // 이미 정상(예: curl 업로드)이면 원본 그대로 둡니다.
  const recovered = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const originalname = recovered.includes('�') ? req.file.originalname : recovered;
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
  await db.saveCurriculumDoc(originalname, text);
  res.json({ message: '자료가 업로드되었습니다.', filename: originalname, length: text.length });
});

// 현재 업로드된 학원 자료 목록 확인 (원장님 전용)
app.get('/api/curriculum', requireAdminAuth, async (_req, res) => {
  const docs = await db.listCurriculumDocs();
  res.json({
    documents: docs.map((d) => ({ id: d.id, filename: d.filename, uploadedAt: d.uploadedAt, length: d.content.length })),
    aiEnabled: aiChat.isConfigured,
  });
});

// 업로드된 학원 자료 삭제 (원장님 전용)
app.delete('/api/curriculum/:id', requireAdminAuth, async (req, res) => {
  const deleted = await db.deleteCurriculumDoc(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: '삭제할 자료를 찾을 수 없어요.' });
  res.json({ message: '자료가 삭제되었습니다.' });
});

app.get('/api/reservations/status', async (_req, res) => {
  const count = await db.countConfirmed();
  res.json({ capacity, reserved: count, remaining: Math.max(0, capacity - count), full: count >= capacity });
});

app.get('/api/reservations/slots', async (_req, res) => res.json({ slots: await getSlots() }));

app.post('/api/reservations', async (req, res) => {
  const validated = await validateReservation(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const { data, slot } = validated;
  const count = await db.countConfirmed();
  if (count >= capacity) return res.status(409).json({ error: '현재 상담 예약이 마감되었어요. 학원으로 문의해 주세요.' });
  try {
    const manageToken = randomUUID();
    const id = await db.createReservation({
      studentName: data.studentName, phone: data.phone, studentGrade: data.studentGrade,
      school: data.school, slotId: data.slotId, note: data.note, manageToken,
    });
    console.log(`[새 레벨 테스트 예약] ${data.studentName} / ${data.studentGrade} / ${slot.label}`);
    notifyOwner(
      `[모연 English] 레벨테스트 예약 접수\n학생: ${data.studentName} (${data.studentGrade}, ${data.school})\n일정: ${slot.label}\n연락처: ${data.phone}`
    ).catch((err) => console.error('[문자 알림 처리 중 오류]', err));
    res.status(201).json({ id, manageToken, message: '레벨 테스트 예약이 확정되었습니다!', remaining: capacity - count - 1, confirmation: { studentName: data.studentName, school: data.school, dateTime: slot.label, place: academyPlace, materials, resultGuide, reminder: '예약 하루 전 보호자 연락처로 문자(SMS) 안내 예정' } });
  } catch (error) {
    if (db.isUniqueViolation(error)) return res.status(409).json({ error: '이미 예약된 연락처예요. 변경은 학원으로 문의해 주세요.' });
    console.error(error);
    res.status(500).json({ error: '예약 저장 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

app.patch('/api/reservations/:id', async (req, res) => {
  const id = Number(req.params.id);
  const token = String(req.body?.manageToken || '');
  const current = await db.findConfirmedByToken(id, token);
  if (!current) return res.status(404).json({ error: '변경할 예약을 찾을 수 없어요.' });
  const validated = await validateReservation(req.body, id);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const { data, slot } = validated;
  await db.updateReservation(id, {
    studentName: data.studentName, phone: data.phone, studentGrade: data.studentGrade,
    school: data.school, slotId: data.slotId, note: data.note,
  });
  res.json({ message: '예약이 변경되었습니다.', confirmation: { studentName: data.studentName, school: data.school, dateTime: slot.label, place: academyPlace, materials, resultGuide } });
});

app.delete('/api/reservations/:id', async (req, res) => {
  const id = Number(req.params.id);
  const token = String(req.body?.manageToken || '');
  const cancelled = await db.cancelReservation(id, token);
  if (!cancelled) return res.status(404).json({ error: '취소할 예약을 찾을 수 없어요.' });
  res.json({ message: '예약이 취소되었습니다. 다른 시간으로 언제든 다시 신청해 주세요.' });
});

app.get('/api/reservations', requireAdminAuth, async (_req, res) => {
  const reservations = await db.listReservations();
  res.json({ capacity, reservations });
});

app.get('/api/reminders/due', requireAdminAuth, async (_req, res) => {
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const reminders = await db.listReminderDue(tomorrow);
  res.json({ channel: '문자(SMS) 발송 서비스 연동 대기', reminders });
});

db.initDb()
  .then(() => {
    app.listen(port, () => console.log(`모연 학원 챗봇 서버가 켜졌습니다: http://localhost:${port} (DB: ${db.DB_MODE})`));
  })
  .catch((err) => {
    console.error('DB 초기화 실패:', err);
    process.exit(1);
  });
