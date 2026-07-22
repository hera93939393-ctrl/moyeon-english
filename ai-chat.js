// ============================================================
//  AI 챗봇 두뇌 - Claude API 연동
//  ------------------------------------------------------------
//  .env 에 ANTHROPIC_API_KEY 가 있으면 → 진짜 AI가 답변
//  없으면 → 호출부(server.js)에서 기존 키워드 매칭 방식으로 대체
// ============================================================
const Anthropic = require('@anthropic-ai/sdk');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const isConfigured = !!API_KEY;
const client = isConfigured ? new Anthropic({ apiKey: API_KEY }) : null;

// 저렴하고 간단한 FAQ 답변에 충분한 모델
const MODEL = 'claude-haiku-4-5';

function buildSystemPrompt(academy, curriculumText) {
  const faq = Object.entries(academy.answers || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');

  let system = `당신은 "${academy.name}" 학원의 안내 챗봇입니다.
학부모의 질문에 친절하고 간결한 존댓말로 답하세요.

아래 정보에 근거해서만 답변하세요. 정보에 없는 내용은 지어내지 말고,
"자세한 내용은 학원으로 문의해 주세요"라고 안내하세요.

# 학원 기본 정보
- 이름: ${academy.name}
- 소개: ${academy.tagline}
- 프로모션: ${academy.promotion}
- 주소: ${academy.address}
- 교통: ${academy.transit}
- 주차: ${academy.parking}

# 자주 묻는 질문 요약
${faq}`;

  if (curriculumText) {
    system += `\n\n# 원장님이 업로드한 상세 커리큘럼 자료\n${curriculumText}`;
  }
  return system;
}

// AI 미설정 또는 오류 시 null을 반환 (호출부에서 키워드 방식으로 대체)
async function getAnswer({ question, academy, curriculumText }) {
  if (!isConfigured || !question) return null;

  const system = buildSystemPrompt(academy, curriculumText);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: question }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : null;
}

module.exports = { getAnswer, isConfigured };
