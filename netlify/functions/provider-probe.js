// Temporary provider health probe. Remove before merging the final search change.
exports.handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const state = {};
  const key = process.env.HIRA_API_KEY;
  if (!key) state.hira = { configured: false };
  else {
    try {
      const url = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList'
        + '?serviceKey=' + encodeURIComponent(key) + '&yadmNm=' + encodeURIComponent('서울아산병원')
        + '&numOfRows=2&pageNo=1&_type=json';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = await res.text();
      state.hira = { configured: true, status: res.status,
        type: body.trimStart().startsWith('<') ? 'xml' : 'json',
        matches: (body.match(/<item>|"yadmNm"/g) || []).length };
    } catch (err) { state.hira = { configured: true, error: err.name }; }
  }
  const kakao = process.env.KAKAO_REST_KEY;
  if (!kakao) state.kakao = { configured: false };
  else {
    try {
      const res = await fetch('https://dapi.kakao.com/v2/local/search/keyword.json?query='
        + encodeURIComponent('서울아산병원') + '&category_group_code=HP8&size=5',
      { headers: { Authorization: 'KakaoAK ' + kakao }, signal: AbortSignal.timeout(8000) });
      let matches = 0;
      if (res.ok) matches = (await res.json()).documents?.length || 0;
      state.kakao = { configured: true, status: res.status, matches };
    } catch (err) { state.kakao = { configured: true, error: err.name }; }
  }
  return { statusCode: 200, headers, body: JSON.stringify(state) };
};
