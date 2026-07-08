// api/subway.js — Vercel Serverless Function (region: icn1 서울)
// 9호선 전 역 도착정보를 병렬 호출 → 열차 위치 추론
// 진단 강화: 타임아웃 원인과 실제 API 에러를 구분해서 표시

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
  const TIMEOUT_MS = 15000; // 리전 이슈 대비 넉넉하게

  function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const start = Date.now();
    return fetch(url, { signal: controller.signal })
      .then(r => ({ r, elapsed: Date.now() - start }))
      .finally(() => clearTimeout(timer));
  }

  // ── 진단 모드: ?debug=1 ──
  if (req.query.debug === '1') {
    const testUrl = `${BASE}/${apiKey}/json/realtimeStationArrival/0/5/개화`;
    const t0 = Date.now();
    try {
      const { r, elapsed } = await fetchWithTimeout(testUrl, TIMEOUT_MS);
      const bodyText = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch {}
      return res.status(200).json({
        debug: true,
        elapsed_ms: elapsed,
        http_status: r.status,
        raw_body: parsed || bodyText,
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
        function_region: process.env.VERCEL_REGION || 'unknown',
      });
    } catch (e) {
      return res.status(200).json({
        debug: true,
        elapsed_ms: Date.now() - t0,
        fetch_error: e.message,
        error_name: e.name,
        is_timeout: e.name === 'AbortError',
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
        function_region: process.env.VERCEL_REGION || 'unknown',
        hint: e.name === 'AbortError'
          ? `${TIMEOUT_MS}ms 안에 서울시 서버로부터 응답이 없었습니다. 함수 리전(${process.env.VERCEL_REGION || 'unknown'})에서 해당 서버로의 네트워크 경로 문제일 수 있습니다.`
          : '타임아웃이 아닌 다른 네트워크 오류입니다 (DNS/연결 거부 등).',
      });
    }
  }

  async function fetchStation(name, idx) {
    const url = `${BASE}/${apiKey}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`;
    try {
      const { r } = await fetchWithTimeout(url, TIMEOUT_MS);
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
      return { idx, arrivals: null, errCode: e.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAIL', errMsg: e.message };
    }
  }

  try {
    const results = await Promise.all(STATIONS.map((name, idx) => fetchStation(name, idx)));

    const trainMap = new Map();
    const AVG_SEC = 90;

    results.forEach(({ idx: stnIdx, arrivals }) => {
      if (!arrivals) return;
      arrivals.forEach(a => {
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
    const timeoutCount = results.filter(r => r.errCode === 'TIMEOUT').length;
    const errorSamples = results.filter(r => r.errCode).slice(0, 5).map(r => ({
      station: STATIONS[r.idx], code: r.errCode, message: r.errMsg
    }));

    if (trains.length === 0) {
      return res.status(200).json({
        trains: [],
        warning: `9호선 열차 데이터 없음 (정상응답: ${successCount}/${STATIONS.length}, 타임아웃: ${timeoutCount})`,
        error_samples: errorSamples,
        function_region: process.env.VERCEL_REGION || 'unknown',
      });
    }

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({ trains, count: trains.length, success_stations: successCount });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
