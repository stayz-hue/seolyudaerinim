// 서류대리님 — 묶음 특급 판정 proxy (카카오 모빌리티 미래 운행)
exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const coordsStr = (event.queryStringParameters || {}).coords || '';
  if (!coordsStr) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: 'coords 필요' }) };

  const points = coordsStr.split(';').map(s => {
    const p = s.split(',');
    return { lat: parseFloat(p[0]), lng: parseFloat(p[1]) };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lng));

  if (points.length < 2) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: '좌표 2개 이상 필요' }) };

  // 오늘 오후 14시 (KST)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const today14 = new Date(now);
  today14.setHours(14, 0, 0, 0);
  if (now >= today14) today14.setDate(today14.getDate() + 1);
  const y = today14.getFullYear();
  const mo = String(today14.getMonth() + 1).padStart(2, '0');
  const d = String(today14.getDate()).padStart(2, '0');
  const depTime = y + mo + d + '1400';

  try {
    let maxMinutes = 0;
    const segments = [];

    for (let i = 0; i < points.length - 1; i++) {
      const o = points[i], dest = points[i + 1];
      const url = 'https://apis-navi.kakaomobility.com/v1/future/directions'
        + '?origin=' + o.lng + ',' + o.lat
        + '&destination=' + dest.lng + ',' + dest.lat
        + '&departure_time=' + depTime;

      const resp = await fetch(url, {
        headers: { 'Authorization': 'KakaoAK ' + process.env.KAKAO_REST_KEY }
      });

      if (!resp.ok) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: 'API_' + resp.status }) };

      const body = await resp.json();
      const routes = body.routes || [];
      if (!routes.length || routes[0].result_code !== 0) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: '경로없음_구간' + (i + 1) }) };
      }

      const mins = Math.ceil(routes[0].summary.duration / 60);
      segments.push({ from: i, to: i + 1, minutes: mins });
      if (mins > maxMinutes) maxMinutes = mins;
    }

    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, maxMinutes, segments, departureTime: depTime }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
