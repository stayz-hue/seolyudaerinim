// netlify/functions/search.js
// ══════════════════════════════════════════════════════════════
// 병원 검색 — 3단 안전망 (오차 0건 목표)
//
// ① Claude 정규화  (줄임말→정식명, 오타 교정)
// ② 네이버 지역검색 (메인 — 좌표 정밀, 주소/이름 전부)
// ③ 심평원 병원정보서비스 (fallback — 신규/마이너 병원 누락 방지)
//
// 좌표 원칙: 네이버 우선. 심평원 좌표는 최후 수단(네이버 미등록 시만).
// 심평원 역할: 병원명 확보 + 신규병원 좌표 fallback
// ══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const query = (event.queryStringParameters?.q || '').trim();
  if (!query || query.length < 2) {
    return resp(headers, { ok: false, error: '검색어 2자 이상' });
  }

  try {
    // ── Step 1: Claude 정규화 ──
    let normalized = query;
    try {
      normalized = await normalizeHospitalName(query);
      if (normalized !== query) console.log(`[정규화] "${query}" → "${normalized}"`);
    } catch (e) {
      console.log(`[정규화 실패] 원본 사용: ${e.message}`);
    }

    // ── Step 2: 네이버 검색 (메인) ──
    let result = await searchNaver(normalized);

    // 정규화 결과로 못 찾으면 → 원본으로 재시도
    if (empty(result) && normalized !== query) {
      console.log(`[네이버 재검색] 원본 "${query}"`);
      result = await searchNaver(query);
    }

    // ── Step 3: 네이버 성공 → 끝 ──
    if (!empty(result)) {
      return resp(headers, result);
    }

    // ── Step 4: 네이버 실패 → 심평원 fallback ──
    console.log(`[심평원 진입] 네이버 결과 없음`);
    let hiraPlaces = await searchHIRA(normalized);

    if ((!hiraPlaces || hiraPlaces.length === 0) && normalized !== query) {
      hiraPlaces = await searchHIRA(query);
    }

    if (!hiraPlaces || hiraPlaces.length === 0) {
      return resp(headers, { ok: true, places: [] });
    }

    // ── Step 5: 심평원 병원명으로 네이버 좌표 업그레이드 ──
    const upgraded = await upgradeWithNaver(hiraPlaces);
    return resp(headers, { ok: true, places: upgraded });

  } catch (err) {
    console.error('[search] 에러:', err.message);
    return resp(headers, { ok: false, error: err.message });
  }
};


// ═══════════ 유틸 ═══════════
function empty(r) { return !r || !r.ok || !r.places || r.places.length === 0; }
function resp(h, data) { return { statusCode: 200, headers: h, body: JSON.stringify(data) }; }


// ══════════════════════════════════════════════════
// ① Claude API 병원명 정규화
// ══════════════════════════════════════════════════
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


// ══════════════════════════════════════════════════
// ② 네이버 지역검색 (메인 — 좌표 정밀)
// ══════════════════════════════════════════════════
async function searchNaver(query) {
  const cid = process.env.NAVER_CLIENT_ID;
  const csc = process.env.NAVER_CLIENT_SECRET;
  if (!cid || !csc) return { ok: false, error: 'NAVER키 없음' };

  const q = query;

  const res = await fetch(
    'https://openapi.naver.com/v1/search/local.json?query='
    + encodeURIComponent(q) + '&display=5',
    { headers: { 'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csc } }
  );
  if (!res.ok) return { ok: false, error: 'NAVER_' + res.status };

  const body = await res.json();
  const items = body.items || [];

  // 의료기관 필터 (정신병원 제외)
  let filtered = items.filter(d => {
    const cat = (d.category || '');
    const name = (d.title || '').replace(/<[^>]*>/g, '');
    if (name.includes('정신') || cat.includes('정신')) return false;
    return cat.includes('병원') || cat.includes('의원') || cat.includes('의료')
      || cat.includes('클리닉') || cat.includes('치과') || cat.includes('한의')
      || name.includes('병원') || name.includes('의원') || name.includes('클리닉');
  });
  if (filtered.length === 0) filtered = items;

  const places = filtered.slice(0, 6).map(d => {
    let lng = parseFloat(d.mapx);
    let lat = parseFloat(d.mapy);
    if (lng > 1000) lng /= 10000000;
    if (lat > 1000) lat /= 10000000;
    return {
      name: d.title.replace(/<[^>]*>/g, ''),
      address: d.roadAddress || d.address || '',
      lat: String(lat),
      lng: String(lng),
      tel: d.telephone || '',
      category: d.category || '',
      source: 'naver'
    };
  });

  return { ok: true, places };
}


// ══════════════════════════════════════════════════
// ③ 심평원 병원정보서비스 (fallback)
//    공공데이터포털: apis.data.go.kr/B551182/hospInfoServicev2
//    역할: 병원명 확보 + 신규병원 좌표(fallback)
// ══════════════════════════════════════════════════
async function searchHIRA(query) {
  const key = process.env.HIRA_API_KEY;
  if (!key) {
    console.log('[심평원] HIRA_API_KEY 미설정 — 스킵');
    return [];
  }

  const url = 'http://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList'
    + '?serviceKey=' + encodeURIComponent(key)
    + '&yadmNm=' + encodeURIComponent(query)
    + '&numOfRows=10&pageNo=1&_type=json';

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[심평원] HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const items = data?.response?.body?.items?.item;
    if (!items) return [];

    // 공공API: 단건이면 객체, 복수건이면 배열
    const list = Array.isArray(items) ? items : [items];

    return list
      .filter(d => !(d.yadmNm || '').includes('정신') && !(d.clCdNm || '').includes('정신'))
      .slice(0, 6)
      .map(d => ({
        name: d.yadmNm || '',
        address: d.addr || '',
        lat: d.YPos ? String(d.YPos) : '',
        lng: d.XPos ? String(d.XPos) : '',
        tel: d.telno || '',
        category: d.clCdNm || '',  // 상급종합, 종합병원, 병원, 의원
        source: 'hira'
      }));

  } catch (err) {
    console.log(`[심평원] 에러: ${err.message}`);
    return [];
  }
}


// ══════════════════════════════════════════════════
// 심평원 결과 → 네이버 좌표 업그레이드
// 심평원 병원명(정식명)으로 네이버 재검색 → 좌표 교체
// 네이버 못 찾으면 심평원 좌표 유지 (최후 수단)
// ══════════════════════════════════════════════════
async function upgradeWithNaver(hiraPlaces) {
  const results = [];

  for (const hp of hiraPlaces) {
    try {
      const naverResult = await searchNaver(hp.name);

      if (!empty(naverResult)) {
        const match = bestMatch(hp.name, naverResult.places);
        if (match) {
          console.log(`[좌표 업그레이드] "${hp.name}" → 네이버 좌표`);
          results.push({
            name: hp.name,                        // 심평원 공식명 유지
            address: match.address || hp.address,  // 네이버 주소 우선
            lat: match.lat,                        // ★ 네이버 좌표
            lng: match.lng,                        // ★ 네이버 좌표
            tel: hp.tel || match.tel,
            category: hp.category,                 // 심평원 종별 유지
            source: 'hira+naver'
          });
          continue;
        }
      }

      // 네이버 매칭 실패 → 심평원 좌표 그대로 (좌표 있을 때만)
      if (hp.lat && hp.lng) {
        console.log(`[좌표 fallback] "${hp.name}" → 심평원 좌표`);
        results.push(hp);
      }

    } catch (err) {
      console.log(`[업그레이드 실패] "${hp.name}": ${err.message}`);
      if (hp.lat && hp.lng) results.push(hp);
    }
  }

  return results;
}


// ══════════════════════════════════════════════════
// 이름 유사도 매칭
// ══════════════════════════════════════════════════
function bestMatch(hiraName, naverPlaces) {
  if (!naverPlaces?.length) return null;

  const norm = s => (s || '').replace(/[\s\(\)·\-]/g, '');
  const target = norm(hiraName);

  let best = null;
  let bestScore = 0;

  for (const np of naverPlaces) {
    const c = norm(np.name);
    if (c === target) return np;  // 정확 일치 → 즉시 반환

    if (c.includes(target) || target.includes(c)) {
      const score = Math.min(c.length, target.length) / Math.max(c.length, target.length);
      if (score > bestScore) { bestScore = score; best = np; }
    }
  }

  return bestScore >= 0.6 ? best : null;
}
