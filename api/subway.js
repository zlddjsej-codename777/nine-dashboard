// api/subway.js — Vercel Serverless Function
// 9호선 전 역 도착정보를 병렬 호출 → 열차 위치 추론
// 진단 강화: 서울 API가 실제로 반환하는 원본 에러코드/메시지를 그대로 노출
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
 
  const apiKey = process.env.api_key;
  if (!apiKey) {
    return res.status(500).json({ error: 'api_key 환경변수가 없습니다.' });
  }
 
  const STATIONS = [
    '개화','김포공항','공항시장','신방화','마곡나루','양천향교',
    '가양','증미','등촌','염창','신목동','선유도',
    '당산','국회의사당','여의도','샛강','노량진','노들',
    '흑석','동작','구반포','신반포','고속터미널','사평',
    '신논현','언주','선정릉','삼성중앙','봉은사','종합운동장',
    '삼전','석촌고분','석촌','송파나루','한성백제','올림픽공원',
    '둔촌오륜','중앙보훈병원'
  ];
 
  const BASE = 'https://swopenapi.seoul.go.kr/api/subway';
  const TIMEOUT_MS = 5000;
 
  function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }
 
  // ── 진단 모드: ?debug=1 이면 첫 번째 역(개화) 원본 응답을 그대로 반환 ──
  if (req.query.debug === '1') {
    const testUrl = `${BASE}/${apiKey}/json/realtimeStationArrival/0/5/개화`;
    try {
      const r = await fetchWithTimeout(testUrl, 6000);
      const bodyText = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch {}
      return res.status(200).json({
        debug: true,
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
        http_status: r.status,
        raw_body: parsed || bodyText,
      });
    } catch (e) {
      return res.status(200).json({
        debug: true,
        fetch_error: e.message,
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
      });
    }
  }
 
  async function fetchStation(name, idx) {
    const url = `${BASE}/${apiKey}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`;
    try {
      const r = await fetchWithTimeout(url, TIMEOUT_MS);
      const bodyText = await r.text();
      let d;
      try { d = JSON.parse(bodyText); } catch {
        return { idx, arrivals: null, errCode: 'PARSE_ERROR', errMsg: bodyText.slice(0, 200) };
      }
      if (d.errorMessage && d.errorMessage.status && d.errorMessage.status >= 400) {
        return { idx, arrivals: null, errCode: d.errorMessage.code, errMsg: d.errorMessage.message };
      }
      return { idx, arrivals: d.realtimeArrivalList || [], errCode: null, errMsg: null };
    } catch (e) {
      return { idx, arrivals: null, errCode: 'FETCH_FAIL', errMsg: e.message };
    }
  }
 
  try {
    const results = await Promise.all(STATIONS.map((name, idx) => fetchStation(name, idx)));
 
    const trainMap = new Map();
    const AVG_SEC = 90;
 
    results.forEach(({ idx: stnIdx, arrivals }) => {
      if (!arrivals) return;
      arrivals.forEach(a => {
        // subwayId 필터를 완화: 9호선 계열 코드(1009) 또는 노선명에 '9호선' 포함
        const is9 = a.subwayId === '1009' || (a.trainLineNm && a.trainLineNm.includes('9호선')) || (a.subwayList && a.subwayList.includes('1009'));
        if (!is9) return;
 
        const num = a.btrainNo;
        if (!num || trainMap.has(num)) return;
 
        const isUp = a.updnLine === '상행';
        const barvlDt = parseInt(a.barvlDt || '0', 10);
        const stationsAway = Math.min(barvlDt / AVG_SEC, 3);
 
        let pos = isUp ? stnIdx - stationsAway : stnIdx + stationsAway;
        pos = Math.max(0, Math.min(STATIONS.length - 1, pos));
 
        trainMap.set(num, {
          id: num, num,
          dir: isUp ? 'up' : 'down',
          pos,
          express: a.btrainSttus === '급행' || a.btrainSttus === '특급',
          speed: 0,
          statnNm: STATIONS[stnIdx],
          barvlDt,
          arvlMsg2: a.arvlMsg2 || '',
        });
      });
    });
 
    const trains = [...trainMap.values()];
    const successCount = results.filter(r => r.arrivals !== null).length;
    const errorSamples = results.filter(r => r.errCode).slice(0, 3).map(r => ({
      station: STATIONS[r.idx], code: r.errCode, message: r.errMsg
    }));
 
    if (trains.length === 0) {
      return res.status(200).json({
        trains: [],
        warning: `9호선 열차 데이터 없음 (정상응답 역: ${successCount}/${STATIONS.length})`,
        error_samples: errorSamples,
      });
    }
 
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({ trains, count: trains.length, success_stations: successCount });
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 
