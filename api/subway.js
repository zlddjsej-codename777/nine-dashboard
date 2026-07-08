// api/subway.js — Vercel Serverless Function (region: icn1 서울)
// 9호선 전 역 도착정보를 병렬 호출 → 열차 위치 추론
//
// 중요: 서울시 서버(swopenapi.seoul.go.kr)는 구형 TLS 설정을 사용하는 경우가 많아
// Node 최신 fetch()의 기본 OpenSSL 3.x 보안레벨(SECLEVEL=2)과 handshake가 실패할 수 있음.
// → Node의 https 모듈을 직접 사용하고 SECLEVEL=1로 낮춰서 legacy TLS 허용.

import https from 'https';

const STATIONS = [
  '개화','김포공항','공항시장','신방화','마곡나루','양천향교',
  '가양','증미','등촌','염창','신목동','선유도',
  '당산','국회의사당','여의도','샛강','노량진','노들',
  '흑석','동작','구반포','신반포','고속터미널','사평',
  '신논현','언주','선정릉','삼성중앙','봉은사','종합운동장',
  '삼전','석촌고분','석촌','송파나루','한성백제','올림픽공원',
  '둔촌오륜','중앙보훈병원'
];

const TIMEOUT_MS = 8000;

// legacy TLS를 허용하는 커스텀 https.Agent
const legacyAgent = new https.Agent({
  keepAlive: false,
  // OpenSSL 3.x 기본 SECLEVEL=2를 1로 낮춰 구형 서버와도 handshake 허용
  ciphers: 'DEFAULT:@SECLEVEL=1',
  minVersion: 'TLSv1',
  rejectUnauthorized: false, // 서울시 서버 구형 인증서 체인 이슈 대비
});

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: legacyAgent }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('TIMEOUT'));
    });
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.api_key;
  if (!apiKey) {
    return res.status(500).json({ error: 'api_key 환경변수가 없습니다.' });
  }

  const BASE = 'https://swopenapi.seoul.go.kr/api/subway';

  // ── 진단 모드: ?debug=1 ──
  if (req.query.debug === '1') {
    const testUrl = `${BASE}/${apiKey}/json/realtimeStationArrival/0/5/개화`;
    const t0 = Date.now();
    try {
      const { status, body } = await httpsGet(testUrl, TIMEOUT_MS);
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      return res.status(200).json({
        debug: true,
        method: 'legacy-tls-https-agent',
        elapsed_ms: Date.now() - t0,
        http_status: status,
        raw_body: parsed || body.slice(0, 500),
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
        function_region: process.env.VERCEL_REGION || 'unknown',
      });
    } catch (e) {
      return res.status(200).json({
        debug: true,
        method: 'legacy-tls-https-agent',
        elapsed_ms: Date.now() - t0,
        fetch_error: e.message,
        error_code: e.code || null,
        requested_url_masked: testUrl.replace(apiKey, '***KEY***'),
        function_region: process.env.VERCEL_REGION || 'unknown',
      });
    }
  }

  async function fetchStation(name, idx) {
    const url = `${BASE}/${apiKey}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`;
    try {
      const { status, body } = await httpsGet(url, TIMEOUT_MS);
      let d;
      try { d = JSON.parse(body); } catch {
        return { idx, arrivals: null, errCode: 'PARSE_ERROR', errMsg: body.slice(0, 200) };
      }
      if (d.errorMessage && d.errorMessage.status && d.errorMessage.status >= 400) {
        return { idx, arrivals: null, errCode: d.errorMessage.code, errMsg: d.errorMessage.message };
      }
      return { idx, arrivals: d.realtimeArrivalList || [], errCode: null, errMsg: null };
    } catch (e) {
      return { idx, arrivals: null, errCode: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'FETCH_FAIL', errMsg: e.message };
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
