# 모연 English 🎓

초등·중등 영어 학원 안내 챗봇 + 레벨테스트 예약 웹 서비스

> Main Quest 1 — 바이브코딩으로 웹 서비스 만들기

**🔗 배포 사이트**: https://moyeon-english-production.up.railway.app

---

## 소개

학부모는 전화 없이 챗봇으로 학원 정보(커리큘럼·시간표·셔틀·수강료·할인 등)를 확인하고,
레벨테스트를 직접 예약·변경·취소할 수 있습니다. 원장은 예약이 접수되는 즉시 문자로
알림을 받고, 관리자 화면에서 정원 현황과 예약 목록을 관리합니다.

## 주요 기능

- 💬 **정보 안내 챗봇** — 버튼 클릭 또는 자유 질문. 원장이 업로드한 커리큘럼 자료를 검색해 답변 (무료, API 비용 없음)
- 📎 **커리큘럼 자료 업로드** — 관리자 전용, PDF/텍스트 파일 지원
- 📅 **레벨테스트 예약** — 달력 UI로 날짜·시간 선택, 정원 관리(일 30명 / 시간대별 2명)
- ✏️ **예약 변경·취소** — 본인 인증 토큰 방식
- 📱 **원장 문자 알림** — 예약 접수 시 SOLAPI로 즉시 SMS 발송
- 🔒 **관리자 화면** (`/admin.html`) — 카테고리별 자료 업로드, 예약 목록·정원 현황 확인. 실제 예약자 개인정보(이름·연락처)가 노출되는 화면이라 로그인(Basic Auth)으로 보호되어 있고, 계정 정보는 공개 저장소에 포함하지 않습니다. 동작 화면은 시연 영상에서 확인하실 수 있습니다.
- 🗑️ **개인정보 자동 삭제** — 예약 데이터 30일 후 자동 파기

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | HTML / CSS / JavaScript (바닐라) |
| 백엔드 | Node.js + Express |
| DB | PostgreSQL ([Neon](https://neon.tech), 클라우드) — `DATABASE_URL` 미설정 시 로컬 SQLite로 자동 대체 |
| 문자 알림 | [SOLAPI](https://solapi.com) SMS API |
| 배포 | [Railway](https://railway.com) (GitHub 연동 자동 배포) |
| (선택) AI 챗봇 | Claude API (Haiku) — `ANTHROPIC_API_KEY` 설정 시 자동 활성화 |

## 로컬에서 실행하기

```bash
npm install
cp .env.example .env   # 값을 채워주세요 (아래 참고)
npm start
```

`.env`에 필요한 값:

```
SOLAPI_API_KEY=       # solapi.com 콘솔에서 발급
SOLAPI_API_SECRET=
SOLAPI_SENDER=        # 등록한 발신번호
OWNER_PHONE=          # 알림 받을 번호
ADMIN_USER=           # 관리자 화면 로그인 아이디
ADMIN_PASSWORD=       # 관리자 화면 로그인 비밀번호
ANTHROPIC_API_KEY=    # (선택) Claude API 키
DATABASE_URL=         # (선택) Neon 등 Postgres 연결 주소, 비우면 SQLite 사용
```

값을 채우지 않아도 서버는 항상 정상 작동합니다 (문자는 콘솔 출력, DB는 로컬 SQLite,
챗봇은 키워드/문서검색 방식으로 자동 대체됩니다).

## 문서

- [PRD.md](./PRD.md) — 상세 제품 요구사항 문서
- [기획서.md](./기획서.md) — 1장 요약 기획 문서
- [회고록.md](./회고록.md) — AI와 협업하며 배운 점 회고
