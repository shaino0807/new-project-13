import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);

function cleanCode(value) {
  return String(value || "").replace(/[^0-9A-Za-z.]/g, "").slice(0, 12).toUpperCase();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") return NaN;
  return Number(String(value).replace(/,/g, ""));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return JSON.parse((await res.text()).trim());
}

async function fetchYahooChart(code) {
  const suffixes = code.includes(".") ? [""] : [".TW", ".TWO"];
  const errors = [];
  for (const suffix of suffixes) {
    const symbol = `${code}${suffix}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false&events=history`;
    try {
      const data = await fetchJson(url);
      const result = data?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      const timestamps = result?.timestamp || [];
      if (!result || !quote || timestamps.length === 0) {
        errors.push(`${symbol}: empty chart`);
        continue;
      }
      const bars = timestamps.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: toNumber(quote.open?.[i]),
        high: toNumber(quote.high?.[i]),
        low: toNumber(quote.low?.[i]),
        close: toNumber(quote.close?.[i]),
        volume: toNumber(quote.volume?.[i]),
      })).filter((row) =>
        Number.isFinite(row.open) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low) &&
        Number.isFinite(row.close)
      );
      if (bars.length < 120) {
        errors.push(`${symbol}: only ${bars.length} daily bars`);
        continue;
      }
      return {
        symbol,
        market: result.meta?.exchangeName === "TWO" ? "OTC" : "TWSE",
        currency: result.meta?.currency || "TWD",
        name: result.meta?.shortName || result.meta?.longName || code,
        week52High: toNumber(result.meta?.fiftyTwoWeekHigh),
        week52Low: toNumber(result.meta?.fiftyTwoWeekLow),
        sourceUrl: url,
        bars,
      };
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function fetchTwseMis(code) {
  const channels = [`tse_${code}.tw`, `otc_${code}.tw`].join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels)}&json=1&delay=0`;
  const data = await fetchJson(url);
  const row = data?.msgArray?.find((item) => item?.c === code && item?.z && item.z !== "-");
  if (!row) return null;
  return {
    name: row.n || code,
    market: row.ex === "otc" ? "OTC" : "TWSE",
    close: toNumber(row.z),
    open: toNumber(row.o),
    high: toNumber(row.h),
    low: toNumber(row.l),
    previousClose: toNumber(row.y),
    volume: toNumber(row.v) * 1000,
    date: row.d ? `${row.d.slice(0, 4)}-${row.d.slice(4, 6)}-${row.d.slice(6, 8)}` : undefined,
    sourceUrl: url,
  };
}

function sma(data, n) {
  return data.map((_, i) => {
    if (i + 1 < n) return null;
    const slice = data.slice(i + 1 - n, i + 1);
    return round(slice.reduce((a, b) => a + b, 0) / n);
  });
}

function ema(data, n) {
  const k = 2 / (n + 1);
  let prev = data[0];
  return data.map((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    return round(prev, 4);
  });
}

function std(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

function boll(data, n = 20, mult = 2) {
  const mid = sma(data, n);
  return data.reduce((acc, close, i) => {
    if (i + 1 < n || mid[i] === null) {
      acc.up.push(null); acc.low.push(null); acc.pctB.push(null); acc.bw.push(null);
      return acc;
    }
    const s = std(data.slice(i + 1 - n, i + 1));
    const m = mid[i];
    const up = m + mult * s;
    const low = m - mult * s;
    acc.up.push(round(up));
    acc.low.push(round(low));
    acc.pctB.push(round((close - low) / (up - low), 3));
    acc.bw.push(round(((up - low) / m) * 100));
    return acc;
  }, { mid, up: [], low: [], pctB: [], bw: [] });
}

function rsi(data, n = 14) {
  return data.map((_, i) => {
    if (i < n) return null;
    let gain = 0;
    let loss = 0;
    for (let j = i - n + 1; j <= i; j += 1) {
      const diff = data[j] - data[j - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    if (loss === 0) return 100;
    return round(100 - 100 / (1 + gain / loss));
  });
}

function kd(closes, highs, lows, n = 9) {
  const k = [];
  const d = [];
  let prevK = 50;
  let prevD = 50;
  closes.forEach((close, i) => {
    if (i + 1 < n) {
      k.push(null); d.push(null); return;
    }
    const hh = Math.max(...highs.slice(i + 1 - n, i + 1));
    const ll = Math.min(...lows.slice(i + 1 - n, i + 1));
    const rsv = hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
    prevK = prevK * 2 / 3 + rsv / 3;
    prevD = prevD * 2 / 3 + prevK / 3;
    k.push(round(prevK));
    d.push(round(prevD));
  });
  return { k, d };
}

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return NaN;
}

function closeNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function buildAnalysis(series, week52High, week52Low) {
  const closes = series.map((row) => row.close);
  const highs = series.map((row) => row.high);
  const lows = series.map((row) => row.low);
  const volumes = series.map((row) => row.volume || 0);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const bb = boll(closes);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((v, i) => round(v - ema26[i], 4));
  const dea = ema(dif, 9);
  const hist = dif.map((v, i) => round((v - dea[i]) * 2, 4));
  const rsi14 = rsi(closes);
  const kdData = kd(closes, highs, lows);
  const close = closes[closes.length - 1];
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeRatio = avgVol20 > 0 ? closeNumber(volumes[volumes.length - 1] / avgVol20) : 1;
  const supportShort = Math.min(...lows.slice(-20));
  const supportMid = Math.min(...lows.slice(-60));
  const resistanceShort = Math.max(...highs.slice(-20));
  const resistanceMid = Math.max(...highs.slice(-60));
  const rsiNow = lastFinite(rsi14);
  const kNow = lastFinite(kdData.k);
  const dNow = lastFinite(kdData.d);
  const pctBNow = lastFinite(bb.pctB);
  const bwNow = lastFinite(bb.bw);
  const ma20Now = lastFinite(ma20);
  const ma60Now = lastFinite(ma60);
  const ma120Now = lastFinite(ma120);
  const gap120 = Number.isFinite(ma120Now) ? ((close / ma120Now) - 1) * 100 : 0;
  let score = 25;
  if (rsiNow > 70) score += 20; else if (rsiNow > 60) score += 10; else if (rsiNow < 40) score -= 8;
  if (gap120 > 40) score += 15; else if (gap120 > 22) score += 8;
  if (pctBNow > 0.85) score += 10;
  if (volumeRatio > 1.8) score += 15; else if (volumeRatio > 1.25) score += 8;
  if (hist[hist.length - 1] < hist[hist.length - 3]) score += 10;
  if (close > resistanceShort * 0.96) score += 10;
  if (ma20Now > ma60Now && close > ma120Now) score -= 10;
  const pullback = Math.max(15, Math.min(95, Math.round(score)));
  return {
    labels: series.map((row) => row.date),
    closes,
    highs,
    lows,
    volumes,
    ma5,
    ma10,
    ma20,
    ma60,
    ma120,
    bb,
    macd: { dif, dea, hist },
    rsi14,
    kd: kdData,
    levels: {
      supportShort: round(supportShort),
      supportMid: round(supportMid),
      resistanceShort: round(resistanceShort),
      resistanceMid: round(resistanceMid),
    },
    latest: {
      close: round(close),
      ma5: lastFinite(ma5),
      ma10: lastFinite(ma10),
      ma20: ma20Now,
      ma60: ma60Now,
      ma120: ma120Now,
      rsi14: rsiNow,
      k: kNow,
      d: dNow,
      dif: lastFinite(dif),
      dea: lastFinite(dea),
      hist: lastFinite(hist),
      pctB: pctBNow,
      bandwidth: bwNow,
      volumeRatio,
      week52High: Number.isFinite(week52High) ? week52High : Math.max(...highs),
      week52Low: Number.isFinite(week52Low) ? week52Low : Math.min(...lows),
      pullback,
    },
    probabilities: {
      overall: pullback,
      technical: Math.max(15, Math.min(95, Math.round(score + 8))),
      volume: Math.max(15, Math.min(90, Math.round(35 + volumeRatio * 18))),
      wave: Math.max(20, Math.min(90, Math.round(42 + (close / resistanceShort) * 30 + (rsiNow > 65 ? 10 : 0)))),
      fundamental: Math.max(18, Math.min(75, Math.round(48 - (ma20Now > ma60Now ? 8 : 0)))),
      longTerm: Math.max(18, Math.min(82, Math.round(close > ma120Now ? 28 : 64))),
    },
  };
}

async function loadQuote(code) {
  const chart = await fetchYahooChart(code);
  let realtime = null;
  if (/^\d+$/.test(code)) {
    try {
      realtime = await fetchTwseMis(code);
    } catch {
      realtime = null;
    }
  }
  const series = chart.bars.slice(-160);
  if (realtime && Number.isFinite(realtime.close)) {
    const last = series[series.length - 1];
    last.close = realtime.close;
    if (Number.isFinite(realtime.open)) last.open = realtime.open;
    if (Number.isFinite(realtime.high)) last.high = Math.max(last.high, realtime.high);
    if (Number.isFinite(realtime.low)) last.low = Math.min(last.low, realtime.low);
    if (Number.isFinite(realtime.volume) && realtime.volume > 0) last.volume = realtime.volume;
    if (realtime.date) last.date = realtime.date;
  }
  const analysis = buildAnalysis(series, chart.week52High, chart.week52Low);
  const close = analysis.latest.close;
  const previousClose = realtime?.previousClose || series[series.length - 2]?.close;
  return {
    code,
    symbol: chart.symbol,
    name: realtime?.name || chart.name,
    market: realtime?.market || chart.market,
    currency: chart.currency,
    close,
    open: series[series.length - 1].open,
    high: series[series.length - 1].high,
    low: series[series.length - 1].low,
    change: round(Number.isFinite(previousClose) && close !== null ? close - previousClose : NaN),
    volume: series[series.length - 1].volume,
    source: realtime ? "Yahoo Finance daily OHLCV + TWSE MIS realtime quote" : "Yahoo Finance daily OHLCV",
    sourceUrls: {
      yahoo: chart.sourceUrl,
      twseMis: realtime?.sourceUrl || null,
      goodinfo: `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}`,
    },
    series,
    analysis,
  };
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
}

function agentStance(quote) {
  const latest = quote.analysis.latest;
  const trendUp = latest.close !== null && latest.close > latest.ma20 && latest.ma20 > latest.ma60;
  const defensive = latest.close !== null && (latest.close < latest.ma20 || latest.pullback >= 70);
  if (trendUp && latest.pullback < 55) return { label: "偏多續抱", tone: "bull" };
  if (defensive) return { label: "防守觀察", tone: "bear" };
  return { label: "區間觀察", tone: "neutral" };
}

function buildAgentReply(quote, question) {
  const q = String(question || "").trim() || "請給我摘要";
  const text = q.toLowerCase();
  const latest = quote.analysis.latest;
  const levels = quote.analysis.levels;
  const probabilities = quote.analysis.probabilities;
  const close = latest.close || 0;
  const stop = (levels.supportMid || close) * 0.97;
  const entry1Low = (levels.supportShort || close) * 0.99;
  const entry1High = (levels.supportShort || close) * 1.01;
  const entry2Low = (levels.supportMid || close) * 0.99;
  const entry2High = (levels.supportMid || close) * 1.02;
  const target1 = (levels.resistanceShort || close) * 1.04;
  const target2 = latest.week52High * 1.08;
  const stance = agentStance(quote);
  const askedRisk = /risk|pullback|回檔|風險|危險|跌/.test(text);
  const askedEntry = /entry|buy|sell|stop|target|進場|買|賣|停損|目標|策略/.test(text);
  const askedIndicator = /rsi|kd|macd|布林|boll|均線|指標|量|volume/.test(text);
  const askedLevel = /support|resistance|支撐|壓力|區間|價位/.test(text);
  let title = `${quote.code} ${quote.name} 互動分析`;
  let answer = `目前 Agent 判斷為「${stance.label}」。收盤 ${formatNumber(close)}，回檔機率 ${latest.pullback}%，重點是 MA20 ${formatNumber(latest.ma20)} 與近端支撐 ${formatNumber(levels.supportShort)} 是否守住。`;
  const keyPoints = [
    `趨勢：MA20 ${formatNumber(latest.ma20)}、MA60 ${formatNumber(latest.ma60)}、MA120 ${formatNumber(latest.ma120)}。`,
    `動能：RSI14 ${formatNumber(latest.rsi14, 1)}，KD K/D ${formatNumber(latest.k, 1)} / ${formatNumber(latest.d, 1)}，MACD Hist ${formatNumber(latest.hist, 3)}。`,
    `位置：短支撐 ${formatNumber(levels.supportShort)}，中支撐 ${formatNumber(levels.supportMid)}，短壓 ${formatNumber(levels.resistanceShort)}。`,
  ];
  const actions = [
    `不追高：若價格接近 ${formatNumber(levels.resistanceShort)} 且 RSI 高於 70，等待回測比追價更合理。`,
    `分批測試：第一觀察區 ${formatNumber(entry1Low)} - ${formatNumber(entry1High)}，第二觀察區 ${formatNumber(entry2Low)} - ${formatNumber(entry2High)}。`,
    `風控：若跌破 ${formatNumber(stop)} 且無法快速收復，技術結構轉弱。`,
  ];
  if (askedRisk) {
    title = "回檔風險判讀";
    answer = `回檔機率為 ${latest.pullback}%，技術面 ${probabilities.technical}%，量能風險 ${probabilities.volume}%。若收盤跌破 MA20 ${formatNumber(latest.ma20)}，風險會從「觀察」升級為「防守」。`;
    keyPoints.push(`Bollinger %B ${formatNumber(latest.pctB, 2)}、Bandwidth ${formatNumber(latest.bandwidth, 2)}%，用來判斷是否貼近上緣或波動擴大。`);
  } else if (askedEntry) {
    title = "進出場計畫";
    answer = `以目前結構看，不適合一次重倉。較合理的是把 ${formatNumber(entry1Low)} - ${formatNumber(entry1High)} 當第一測試區，${formatNumber(entry2Low)} - ${formatNumber(entry2High)} 當第二測試區，停損看 ${formatNumber(stop)}。`;
    keyPoints.push(`第一目標 ${formatNumber(target1)}，強勢延伸目標 ${formatNumber(target2)}，需搭配成交量是否續增確認。`);
  } else if (askedIndicator) {
    title = "指標拆解";
    answer = `指標目前顯示 ${stance.label}：RSI14 ${formatNumber(latest.rsi14, 1)}、KD ${formatNumber(latest.k, 1)}/${formatNumber(latest.d, 1)}、MACD Hist ${formatNumber(latest.hist, 3)}，成交量為 20 日均量 ${formatNumber(latest.volumeRatio, 2)} 倍。`;
    actions.unshift("先看 MACD Hist 是否連續縮小，再看 KD 是否死亡交叉；兩者同時轉弱時降低部位。");
  } else if (askedLevel) {
    title = "支撐壓力";
    answer = `近端支撐在 ${formatNumber(levels.supportShort)}，中期支撐在 ${formatNumber(levels.supportMid)}；短壓 ${formatNumber(levels.resistanceShort)}，中壓 ${formatNumber(levels.resistanceMid)}。區間內先用分批與停損控風險。`;
    keyPoints.push(`收盤若站上 ${formatNumber(levels.resistanceShort)} 且量能大於均量 1.25 倍，突破可信度較高。`);
  }
  return {
    title,
    stance: stance.label,
    tone: stance.tone,
    confidence: Math.max(45, Math.min(88, 100 - Math.abs(latest.pullback - 50))),
    question: q,
    answer,
    keyPoints,
    actions,
    watchlist: [
      `跌破 MA20 ${formatNumber(latest.ma20)}：短線轉弱警訊。`,
      `突破短壓 ${formatNumber(levels.resistanceShort)}：觀察量能是否放大。`,
      `回檔機率超過 70%：降低追價、提高現金比重。`,
    ],
    disclaimer: "這是技術分析與情境推估，不構成投資建議。",
    generatedAt: new Date().toISOString(),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

const appApiShim = `
window.appApi = {
  async get(url) {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    return { data };
  }
};
window.dispatchEvent(new Event("app-api-ready"));
`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/_healthcheck") {
      sendJson(res, 200, { message: "Success" });
      return;
    }
    if (url.pathname === "/api/quote") {
      const code = cleanCode(url.searchParams.get("code"));
      if (!code) {
        sendJson(res, 400, { ok: false, message: "Missing stock code" });
        return;
      }
      sendJson(res, 200, { ok: true, quote: await loadQuote(code) });
      return;
    }
    if (url.pathname === "/api/agent") {
      const code = cleanCode(url.searchParams.get("code"));
      const question = String(url.searchParams.get("question") || "").slice(0, 500);
      if (!code) {
        sendJson(res, 400, { ok: false, message: "Missing stock code" });
        return;
      }
      const quote = await loadQuote(code);
      sendJson(res, 200, {
        ok: true,
        quote: {
          code: quote.code,
          symbol: quote.symbol,
          name: quote.name,
          market: quote.market,
          close: quote.close,
          source: quote.source,
          sourceUrls: quote.sourceUrls,
        },
        agent: buildAgentReply(quote, question),
      });
      return;
    }
    if (url.pathname === "/src/main.ts") {
      sendText(res, 200, appApiShim, "application/javascript; charset=utf-8");
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(root, requested);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "application/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJson(res, 502, { ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local preview ready at http://127.0.0.1:${port}`);
});
