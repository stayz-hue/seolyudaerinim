// netlify/functions/extract.js — 신분증 정보 자동 추출 (Claude API)
// Netlify 환경변수 ANTHROPIC_API_KEY 필요 (Site settings > Environment variables)

const SYSTEM = `한국 신분증(주민등록증/운전면허증) 이미지에서 아래 3개 필드만 추출해 JSON만 출력.
마크다운 펜스, 다른 텍스트 금지. 못 읽으면 null.
- "성명": 한글 이름만 (한자 병기 제거)
- "생년월일6": 주민번호 앞 6자리 (뒷자리는 가려져 있을 수 있음, 앞 6자리만)
- "주소": 신분증 기재 주소 전체
{"성명": ..., "생년월일6": ..., "주소": ...}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { image, mime } = JSON.parse(event.body || '{}');
    if (!image) return json({ ok: false, error: 'no image' });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: image } },
            { type: 'text', text: '추출' },
          ],
        }],
      }),
    });

    const data = await resp.json();
    if (!data.content || !data.content[0]) {
      return json({ ok: false, error: 'api: ' + JSON.stringify(data).slice(0, 200) });
    }
    const txt = data.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);

    // 생년월일 6자리 → 8자리 (YY > 26 → 19YY, 아니면 20YY)
    let birth = null;
    const six = (parsed['생년월일6'] || '').replace(/[^0-9]/g, '');
    if (six.length === 6) {
      const yy = parseInt(six.slice(0, 2), 10);
      birth = (yy > 26 ? '19' : '20') + six;
    }

    return json({
      ok: true,
      name: parsed['성명'] || null,
      birth: birth,
      address: parsed['주소'] || null,
    });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
};

function json(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
