// 병원 검색: 건강보험심사평가원 병원정보서비스.
// 네이버 검색결과의 가공·혼합 및 개발자센터 검색 API 의존을 제거한다.
// 신청 화면 응답 스키마 {ok, places:[{name,address,lat,lng,tel,category,source}]} 유지.

const HIRA_TIMEOUT_MS = 3500;
const CACHE_LIMIT = 256;
const RESULT_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 1000;
const results = new Map();
const pending = new Map();

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Netlify-Vary': 'query=q'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return resp(headers, { ok: false, error: '허용되지 않은 요청' }, 405);
  const rawQuery = event.queryStringParameters?.q;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length < 2) return resp(headers, { ok: false, error: '검색어 2자 이상' });
  if (query.length > 80) return resp(headers, { ok: false, error: '검색어가 너무 깁니다' });
  if (!process.env.HIRA_API_KEY) return resp(headers, { ok: false, error: '병원 검색 설정을 확인해 주세요' }, 503);

  try {
    // 약칭도 정식명으로 한 번만 조회한다. 결과가 없으면 화면에서 직접 입력할 수 있다.
    const places = await lookupHospital(normalizeHospitalName(query));
    return resp({ ...headers, 'Cache-Control': 'public, max-age=' + (places.length ? 300 : 30),
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=' + (places.length ? 21600 : 30)
    }, { ok: true, places });
  } catch (err) {
    console.error('[병원 검색 실패]', err.message);
    return resp(headers, { ok: false, error: '병원 검색에 실패했습니다' }, 503);
  }
};

function resp(headers, data, statusCode = 200) {
  return { statusCode, headers, body: JSON.stringify(data) };
}

// 동일 정식명은 약칭/띄어쓰기 변형과 동시 요청에서도 재사용한다.
// 성공한 공공 병원 목록만 보관하고, 장애/타임아웃은 즉시 재시도 가능하게 둔다.
async function lookupHospital(query) {
  const cached = results.get(query);
  if (cached) {
    results.delete(query);
    if (cached.expires > Date.now()) {
      results.set(query, cached);
      return cached.places;
    }
  }
  if (pending.has(query)) return pending.get(query);
  const request = searchHIRA(query).then(places => {
    results.set(query, { places, expires: Date.now() + (places.length ? RESULT_TTL_MS : EMPTY_TTL_MS) });
    if (results.size > CACHE_LIMIT) results.delete(results.keys().next().value);
    return places;
  }).finally(() => pending.delete(query));
  pending.set(query, request);
  return request;
}

// 흔히 쓰는 약칭은 즉시 정식명으로 검색한다. 그 외 입력은 그대로 조회한다.
function normalizeHospitalName(query) {
  const aliases = {
    '서울대병원': '서울대학교병원', '분당서울대': '분당서울대학교병원', '분당서울대병원': '분당서울대학교병원',
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
  const res = await fetch(url, { signal: AbortSignal.timeout(HIRA_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HIRA HTTP ' + res.status);
  const data = await res.json();
  if (data?.response?.header?.resultCode !== '00') {
    throw new Error('HIRA resultCode ' + String(data?.response?.header?.resultCode || 'unknown'));
  }
  const body = data.response.body;
  if (!body || typeof body !== 'object') throw new Error('HIRA response body missing');
  const items = body.items?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  if (Number(body.totalCount) > 0 && !list.length) throw new Error('HIRA hospital records missing');
  const places = list.map(toPlace).filter(Boolean);
  if (list.length && !places.length) throw new Error('HIRA hospital records invalid');
  const key = query.replace(/\s+/g, '');
  const rank = name => {
    const value = name.replace(/\s+/g, '');
    return value === key ? 3 : value.endsWith(key) ? 2 : value.includes(key) ? 1 : 0;
  };
  return places.sort((a, b) => rank(b.name) - rank(a.name)).slice(0, 6);
}

function toPlace(item) {
  if (!item || typeof item !== 'object') return null;
  const lat = Number(item.YPos);
  const lng = Number(item.XPos);
  const name = typeof item.yadmNm === 'string' && item.yadmNm.trim();
  const address = typeof item.addr === 'string' && item.addr.trim();
  if (!name || !address) return null;
  const validCoords = item.YPos != null && item.YPos !== '' && item.XPos != null && item.XPos !== ''
    && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
  return {
    name, address, lat: validCoords ? String(lat) : null, lng: validCoords ? String(lng) : null,
    tel: String(item.telno || ''), category: String(item.clCdNm || ''), source: 'hira'
  };
}
