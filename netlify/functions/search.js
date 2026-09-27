// 병원 검색: 건강보험심사평가원 병원정보서비스.
// 네이버 검색결과의 가공·혼합 및 개발자센터 검색 API 의존을 제거한다.
// 신청 화면 응답 스키마 {ok, places:[{name,address,lat,lng,tel,category,source}]} 유지.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return resp(headers, { ok: false, error: '허용되지 않은 요청' }, 405);
  const query = (event.queryStringParameters?.q || '').trim();
  if (query.length < 2) return resp(headers, { ok: false, error: '검색어 2자 이상' });
  if (query.length > 80) return resp(headers, { ok: false, error: '검색어가 너무 깁니다' });
  if (!process.env.HIRA_API_KEY) return resp(headers, { ok: false, error: '병원 검색 설정을 확인해 주세요' }, 503);

  try {
    const normalized = normalizeHospitalName(query);
    let places = await searchHIRA(normalized);
    if (!places.length && normalized !== query) places = await searchHIRA(query);
    return resp(headers, { ok: true, places });
  } catch (err) {
    console.error('[병원 검색 실패]', err.message);
    return resp(headers, { ok: false, error: '병원 검색에 실패했습니다' }, 503);
  }
};

function resp(headers, data, statusCode = 200) {
  return { statusCode, headers, body: JSON.stringify(data) };
}

// 흔히 쓰는 약칭은 즉시 정식명으로 검색한다. 그 외 입력은 그대로 조회한다.
function normalizeHospitalName(query) {
  const aliases = {
    '서울대병원': '서울대학교병원', '분당서울대': '분당서울대학교병원',
    '서울대벙원': '서울대학교병원', '아산병원': '서울아산병원',
    '삼성병원': '삼성서울병원', '고대병원': '고려대학교병원',
    '중앙대병원': '중앙대학교병원', '건대병원': '건국대학교병원',
    '경희대병원': '경희대학교병원', '이대병원': '이화여자대학교병원',
    '한양대병원': '한양대학교병원', '충남대병원': '충남대학교병원',
    '전남대병원': '전남대학교병원', '경북대병원': '경북대학교병원',
    '부산대병원': '부산대학교병원', '인하대병원': '인하대학교병원',
    '아주대병원': '아주대학교병원', '카톨릭병원': '가톨릭대학교병원'
  };
  const key = query.replace(/\s+/g, '');
  return Object.hasOwn(aliases, key) ? aliases[key] : query;
}


// 심평원 병원정보서비스. 운영 프리뷰에서 JSON, resultCode 00, 좌표를 확인했다.
async function searchHIRA(query) {
  const url = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList'
    + '?serviceKey=' + encodeURIComponent(process.env.HIRA_API_KEY)
    + '&yadmNm=' + encodeURIComponent(query)
    + '&numOfRows=20&pageNo=1&_type=json';
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HIRA HTTP ' + res.status);
  const data = await res.json();
  if (data?.response?.header?.resultCode !== '00') {
    throw new Error('HIRA resultCode ' + String(data?.response?.header?.resultCode || 'unknown'));
  }
  const items = data?.response?.body?.items?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  const places = list.map(toPlace).filter(Boolean);
  const key = query.replace(/\s+/g, '');
  const rank = name => {
    const value = name.replace(/\s+/g, '');
    return value === key ? 3 : value.endsWith(key) ? 2 : value.includes(key) ? 1 : 0;
  };
  return places.sort((a, b) => rank(b.name) - rank(a.name)).slice(0, 6);
}

function toPlace(item) {
  const lat = Number(item.YPos);
  const lng = Number(item.XPos);
  const name = String(item.yadmNm || '').trim();
  const address = String(item.addr || '').trim();
  // 좌표 없는 검색결과는 선택 시 경로 계산을 망가뜨리므로 직접 입력으로 안내한다.
  if (!name || !address || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  return {
    name, address, lat: String(lat), lng: String(lng),
    tel: String(item.telno || ''), category: String(item.clCdNm || ''), source: 'hira'
  };
}
