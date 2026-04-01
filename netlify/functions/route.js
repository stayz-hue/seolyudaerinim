// netlify/functions/route.js
// 묶음 특급 판정 — 카카오 모빌리티 미래 운행 정보 API proxy
// coords = "lat1,lng1;lat2,lng2;..." (세미콜론 구분)
// 연속 구간별 소요시간 → 최대값 반환

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const coordsStr = (event.queryStringParameters?.coords || '').trim();
  if (!coordsStr) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: '좌표 필요' }) };
  }

  try {
    const key = process.env.KAKAO_REST_KEY;
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'KAKAO_REST_KEY 미설정' }) };

    const points = coordsStr.split(';').map(s => {
      const [lat, lng] = s.split(',').map(Number);
      return { lat, lng };
    });
    if (points.length < 2) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: '좌표 2개 이상 필요' }) };
    }

    // 오늘 오후 14시 기준 (접수 시간 무관, 오후 통행 기준)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const today14 = new Date(now);
    today14.setHours(14, 0, 0, 0);
    if (now >= today14) today14.setDate(today14.getDate() + 1);

    const Y = today14.getFullYear();
    const M = String(today14.getMonth() + 1).padStart(2, '0');
    const D = String(today14.getDate()).padStart(2, '0');
    const depTime = `${Y}${M}${D}1400`; // yyyyMMddHHmm

    let maxMinutes = 0;
    const segments = [];

    // 연속 구간별 API 호출 (1→2, 2→3, ...)
    for (let i = 0; i < points.length - 1; i++) {
      const origin = points[i];
      const dest = points[i + 1];
      const url = 'https://apis-navi.kakaomobility.com/v1/future/directions'
        + '?origin=' + origin.lng + ',' + origin.lat
        + '&destination=' + dest.lng + ',' + dest.lat
        + '&departure_time=' + depTime;

      const resp = await fetch(url, {
        headers: { 'Authorization': 'KakaoAK ' + key }
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`카카오 API 오류 [구간${i + 1}]: ${errText.slice(0, 200)}`);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'API_' + resp.status }) };
      }

      const body = await resp.json();
      if (!body.routes?.length || body.routes[0].result_code !== 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: '경로없음_구간' + (i + 1) }) };
      }

      const durationSec = body.routes[0].summary.duration;
      const minutes = Math.ceil(durationSec / 60);
      segments.push({ from: i, to: i + 1, minutes });
      if (minutes > maxMinutes) maxMinutes = minutes;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, maxMinutes, segments, departureTime: depTime })
    };

  } catch (err) {
    console.error('[route] 에러:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
