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
    let normalized = query;
    try {
      normalized = await normalizeHospitalName(query);
    } catch (err) {
      console.log('[병원명 정규화 실패]', err.message);
    }
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

// Claude는 고객이 입력한 검색어만 정규화하며, 병원 API 결과를 전달하지 않는다.
async function normalizeHospitalName(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return query;

  // 이미 정식 명칭 패턴 → API 스킵 (비용 절감)
  if (/대학교.{0,4}병원|의료원$|센터$/.test(query)) return query;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `한국 병원 검색어를 공식 명칭으로 변환. 병원명만 출력(설명 없이).

규칙:
- 줄임말→정식명칭 (고대병원→고려대학교병원, 서울대병원→서울대학교병원, 삼성병원→삼성서울병원, 아산병원→서울아산병원, 을지병원→을지대학교병원, 세브란스→세브란스병원, 분당서울대→분당서울대학교병원, 중앙대병원→중앙대학교병원, 건대병원→건국대학교병원, 경희대병원→경희대학교병원, 이대병원→이화여자대학교병원, 한양대병원→한양대학교병원, 충남대병원→충남대학교병원, 전남대병원→전남대학교병원, 경북대병원→경북대학교병원, 부산대병원→부산대학교병원, 인하대병원→인하대학교병원, 아주대병원→아주대학교병원, 카톨릭병원→가톨릭대학교병원, 순천향병원→순천향대학교병원)
- 오타 교정 (서울대벙원→서울대학교병원)
- 이미 정식이거나 동네의원이면 그대로
- 모르면 원본 그대로

입력: ${query}`
      }]
    })
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  if (!text || text.length > 40 || text.includes('\n')) return query;
  return text;
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
