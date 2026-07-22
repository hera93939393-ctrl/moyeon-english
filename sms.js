// ============================================================
//  원장님께 예약 알림 보내기 - 솔라피(SOLAPI) SMS 연동
//  ------------------------------------------------------------
//  .env 에 아래 4개 값이 모두 채워져 있으면 → 실제 문자 발송
//  하나라도 비어 있으면 → 문자 대신 콘솔에 "발송될 내용"만 출력 (시제품 모드)
//
//    SOLAPI_API_KEY    : 솔라피 콘솔 > API Key 관리 에서 확인
//    SOLAPI_API_SECRET : 솔라피 콘솔 > API Key 관리 에서 확인
//    SOLAPI_SENDER     : 솔라피에 등록한 발신번호 (예: 01012345678, - 없이)
//    OWNER_PHONE       : 알림 받을 원장님 번호 (예: 01098765432, - 없이)
// ============================================================
const { SolapiMessageService } = require('solapi');

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER = process.env.SOLAPI_SENDER;
const OWNER_PHONE = process.env.OWNER_PHONE;

const isConfigured = !!(API_KEY && API_SECRET && SENDER && OWNER_PHONE);
const messageService = isConfigured ? new SolapiMessageService(API_KEY, API_SECRET) : null;

// 원장님께 예약 알림 문자를 보냅니다.
async function notifyOwner(text) {
  if (!isConfigured) {
    console.log('\n📩 [문자 알림 - 시제품 모드] (.env 에 솔라피 정보를 채우면 실제 발송됩니다)');
    console.log('  ' + text.replace(/\n/g, '\n  '));
    console.log('');
    return { sent: false, mode: 'console' };
  }

  try {
    const res = await messageService.send({ to: OWNER_PHONE, from: SENDER, text });
    return { sent: true, mode: 'solapi', response: res };
  } catch (err) {
    console.error('[문자 발송 실패]', err.message);
    return { sent: false, mode: 'error', error: err.message };
  }
}

module.exports = { notifyOwner, isConfigured };
