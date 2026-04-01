// 서류대리님 — 병원 검색 proxy (네이버 지역 검색)
exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const q = (event.queryStringParameters || {}).q || '';
  if (q.length < 1) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: '검색어 필요' }) };

  const sq = (q.indexOf('병원') < 0 && q.indexOf('의원') < 0 && q.indexOf('의료') < 0) ? q + ' 병원' : q;

  try {
    const resp = await fetch('https://openapi.naver.com/v1/search/local.json?query=' + encodeURIComponent(sq) + '&display=10', {
      headers: { 'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET }
    });
    if (!resp.ok) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: 'API_' + resp.status }) };

    const data = await resp.json();
    const items = data.items || [];
    const exCat = ['카페','커피','음식','식당','푸드','레스토랑','베이커리','플레이스','편의점','마트','약국'];
    const exName = /병원.{0,2}(점|코트|카페|매장|식당|편의)/;

    const places = [];
    for (const d of items) {
      const cat = d.category || '';
      const name = (d.title || '').replace(/<[^>]*>/g, '');
      if (name.indexOf('정신') >= 0 || cat.indexOf('정신') >= 0) continue;
      if (exCat.some(x => cat.indexOf(x) >= 0)) continue;
      if (exName.test(name)) continue;
      const isMed = ['병원','의원','의료','클리닉','치과','한의','한방'].some(x => cat.indexOf(x) >= 0)
        || ['병원','의원','클리닉'].some(x => name.indexOf(x) >= 0);
      if (!isMed) continue;
      places.push({
        name, address: d.roadAddress || d.address || '',
        lat: String(parseInt(d.mapy, 10) / 10000000),
        lng: String(parseInt(d.mapx, 10) / 10000000)
      });
      if (places.length >= 6) break;
    }
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, places }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
