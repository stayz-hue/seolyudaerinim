// netlify/functions/geocode.js
// 주소 → 좌표 변환 (카카오 로컬 REST API)
// 직접 입력 병원의 묶음판정용 좌표 확보

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const address = (event.queryStringParameters?.address || '').trim();
  if (!address) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: '주소 필요' }) };
  }

  const key = process.env.KAKAO_REST_KEY;
  if (!key) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'KAKAO키 없음' }) };
  }

  try {
    // 1차: 주소 검색
    let result = await kakaoAddress(address, key);

    // 2차: 주소 검색 실패 시 키워드 검색 (건물명 등)
    if (!result) {
      result = await kakaoKeyword(address, key);
    }

    if (result) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: '좌표변환 실패' }) };

  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

async function kakaoAddress(query, key) {
  const res = await fetch(
    'https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(query),
    { headers: { Authorization: 'KakaoAK ' + key } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const doc = data.documents?.[0];
  if (!doc) return null;
  return { lat: doc.y, lng: doc.x, address: doc.address_name || query };
}

async function kakaoKeyword(query, key) {
  const res = await fetch(
    'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(query),
    { headers: { Authorization: 'KakaoAK ' + key } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const doc = data.documents?.[0];
  if (!doc) return null;
  return { lat: doc.y, lng: doc.x, address: doc.road_address_name || doc.address_name || query };
}
