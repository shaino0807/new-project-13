import { router, json, error } from "@appdeploy/sdk";

type DailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type QuoteInfo = {
  code: string;
  symbol: string;
  name: string;
  market: string;
  currency: string;
  close: number;
  open: number;
  high: number;
  low: number;
  change: number | null;
  volume: number;
  source: string;
  sourceUrls: Record<string, string | null>;
  series: DailyBar[];
  analysis: ReturnType<typeof buildAnalysis>;
};

const FALLBACK_NAMES: Record<string, string> = {
  "0050": "元大台灣50",
  "2303": "聯電",
  "2308": "台達電",
  "2317": "鴻海",
  "2330": "台積電",
  "2344": "華邦電",
  "2356": "英業達",
  "2382": "廣達",
  "2454": "聯發科",
  "3231": "緯創",
};

function cleanCode(value: string | undefined) {
  return String(value || "").replace(/[^0-9A-Za-z.]/g, "").slice(0, 12).toUpperCase();
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "-" || value === "") return NaN;
  return Number(String(value).replace(/[,+%]/g, "").trim());
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return NaN;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

async function fetchJson(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return JSON.parse((await res.text()).trim());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/rss+xml,application/xml,text/xml,text/html,*/*",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooChart(code: string) {
  const suffixes = code.includes(".") ? [""] : [".TW", ".TWO"];
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const errors: string[] = [];

  for (const suffix of suffixes) {
    for (const host of hosts) {
      const symbol = `${code}${suffix}`;
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false&events=history`;
      try {
        const data = await fetchJson(url);
        const result = data?.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0];
        const timestamps = result?.timestamp || [];
        if (!result || !quote || timestamps.length === 0) {
          errors.push(`${symbol}: empty chart`);
          continue;
        }

        const bars: DailyBar[] = timestamps.map((ts: number, i: number) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open: toNumber(quote.open?.[i]),
          high: toNumber(quote.high?.[i]),
          low: toNumber(quote.low?.[i]),
          close: toNumber(quote.close?.[i]),
          volume: toNumber(quote.volume?.[i]),
        })).filter((row: DailyBar) =>
          Number.isFinite(row.open) &&
          Number.isFinite(row.high) &&
          Number.isFinite(row.low) &&
          Number.isFinite(row.close)
        );

        if (bars.length < 80) {
          errors.push(`${symbol}: only ${bars.length} usable bars`);
          continue;
        }

        return {
          symbol,
          market: result.meta?.exchangeName === "TWO" ? "OTC" : "TWSE",
          currency: result.meta?.currency || "TWD",
          name: result.meta?.shortName || result.meta?.longName || FALLBACK_NAMES[code] || code,
          week52High: toNumber(result.meta?.fiftyTwoWeekHigh),
          week52Low: toNumber(result.meta?.fiftyTwoWeekLow),
          sourceUrl: url,
          bars,
        };
      } catch (err) {
        errors.push(`${symbol}@${host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  throw new Error(errors.join("; "));
}

async function fetchTwseMis(code: string) {
  const channels = [`tse_${code}.tw`, `otc_${code}.tw`].join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels)}&json=1&delay=0`;
  const data = await fetchJson(url, 7000);
  const row = data?.msgArray?.find((item: any) => item?.c === code && item?.z && item.z !== "-");
  if (!row) return null;

  return {
    name: row.n || FALLBACK_NAMES[code] || code,
    market: row.ex === "otc" ? "OTC" : "TWSE",
    close: toNumber(row.z),
    open: toNumber(row.o),
    high: toNumber(row.h),
    low: toNumber(row.l),
    previousClose: toNumber(row.y),
    volume: toNumber(row.v) * 1000,
    date: row.d ? `${row.d.slice(0, 4)}-${row.d.slice(4, 6)}-${row.d.slice(6, 8)}` : undefined,
    time: row.t,
    sourceUrl: url,
  };
}

async function fetchExchangeSnapshot(code: string) {
  const endpoints = [
    { market: "TWSE", url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL" },
    { market: "OTC", url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes" },
  ];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint.url);
      const row = Array.isArray(data) ? data.find((item: any) =>
        String(item.Code || item.SecuritiesCompanyCode || item.SecuritiesCode || item["證券代號"]) === code
      ) : null;
      if (!row) continue;
      const close = toNumber(row.ClosingPrice || row.Close || row.close || row["收盤價"]);
      if (!Number.isFinite(close)) continue;
      return {
        name: row.Name || row.CompanyName || row.SecuritiesCompanyName || row["證券名稱"] || FALLBACK_NAMES[code] || code,
        market: endpoint.market,
        close,
        open: toNumber(row.OpeningPrice || row.Open || row.open || row["開盤價"]),
        high: toNumber(row.HighestPrice || row.High || row.high || row["最高價"]),
        low: toNumber(row.LowestPrice || row.Low || row.low || row["最低價"]),
        change: toNumber(row.Change || row.PriceChange || row["漲跌價差"]),
        volume: toNumber(row.TradeVolume || row.Volume || row.TradingShares || row["成交股數"] || row["成交量"]),
        date: new Date().toISOString().slice(0, 10),
        sourceUrl: endpoint.url,
      };
    } catch (err) {
      errors.push(`${endpoint.market}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(errors.join("; "));
}

type NewsItem = {
  title: string;
  link: string;
  source: string;
  publishedAt: string | null;
  snippet: string;
};

function decodeXml(value: string) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(value: string) {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRssItems(xml: string): NewsItem[] {
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).slice(0, 8).map((match) => {
    const item = match[0];
    const pubDate = tagValue(item, "pubDate");
    const date = pubDate ? new Date(pubDate) : null;
    const source = tagValue(item, "source") || "Google News";
    return {
      title: stripTags(tagValue(item, "title")),
      link: stripTags(tagValue(item, "link")),
      source: stripTags(source),
      publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
      snippet: stripTags(tagValue(item, "description")).slice(0, 220),
    };
  }).filter((item) => item.title && item.link);
}

function stockThemes(code: string, name: string) {
  const base = ["台股", "股票", name, code].filter(Boolean);
  const semiconductorNames = ["台積", "聯電", "華邦", "聯發", "半導體", "晶片"];
  const electronicsNames = ["電", "鴻海", "廣達", "緯創", "英業達"];
  const semiconductor = ["2330", "2303", "2344", "2454"].includes(code) || semiconductorNames.some((word) => name.includes(word));
  const electronics = ["2308", "2317", "2356", "2382", "3231"].includes(code) || electronicsNames.some((word) => name.includes(word));
  if (semiconductor) return [...base, "半導體", "晶片", "AI", "先進製程", "封測", "晶圓", "記憶體", "IC設計"];
  if (electronics) return [...base, "AI伺服器", "電子", "代工", "電源", "供應鏈", "伺服器", "筆電"];
  if (code === "0050") return [...base, "ETF", "大盤", "權值股", "台灣50", "指數"];
  return base;
}

function countMatches(text: string, words: string[]) {
  return words.reduce((count, word) => count + (word && text.includes(word) ? 1 : 0), 0);
}

function classifyNews(item: NewsItem, code: string, name: string) {
  const text = `${item.title} ${item.snippet}`;
  const themes = stockThemes(code, name);
  const directHit = text.includes(code) || Boolean(name && text.includes(name));
  const themeHits = countMatches(text, themes);
  const bullWords = ["成長", "創高", "上修", "受惠", "訂單", "擴產", "漲", "突破", "買超", "獲利", "增溫", "看旺", "法說"];
  const bearWords = ["下修", "衰退", "虧損", "跌", "賣超", "降評", "裁員", "庫存", "警示", "減少", "疲弱", "利空"];
  const bull = countMatches(text, bullWords);
  const bear = countMatches(text, bearWords);
  const relation = directHit ? "直接相關" : themeHits >= 2 ? "間接相關" : "無關雜訊";
  const sentiment = bull > bear ? "利多" : bear > bull ? "利空" : "中性";
  const shortWords = ["今日", "盤中", "外資", "買超", "賣超", "股價", "開盤", "收盤"];
  const midWords = ["月營收", "季報", "法說", "訂單", "庫存", "匯率", "產品", "展望"];
  const longWords = ["產業", "長期", "擴產", "資本支出", "政策", "趨勢", "投資"];
  const revenueWords = ["營收", "訂單", "出貨", "客戶"];
  const marginWords = ["毛利", "成本", "匯率", "報價", "價格"];
  const valuationWords = ["本益比", "目標價", "評等", "估值"];
  const industryWords = ["AI", "政策", "產業", "擴產", "資本支出"];
  const horizon = countMatches(text, shortWords) > 0
    ? "短線"
    : countMatches(text, midWords) > 0
      ? "中線"
      : countMatches(text, longWords) > 0
        ? "長線"
        : "中線";
  const confidence = Math.max(25, Math.min(92, (directHit ? 60 : themeHits >= 2 ? 42 : 25) + Math.min(18, themeHits * 6) + Math.min(10, (bull + bear) * 3)));
  const impact = countMatches(text, revenueWords) > 0
    ? "可能影響營收與未來成長想像"
    : countMatches(text, marginWords) > 0
      ? "可能影響毛利與獲利壓力"
      : countMatches(text, valuationWords) > 0
        ? "可能影響估值與市場期待"
        : countMatches(text, industryWords) > 0
          ? "可能影響產業方向與長期敘事"
          : "主要影響市場情緒，需再用營收與財報驗證";

  return {
    ...item,
    relation,
    sentiment,
    horizon,
    confidence,
    impact,
  };
}

async function loadNews(code: string, name = FALLBACK_NAMES[code] || code) {
  const query = `${code} ${name} 股票 OR 台股`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const xml = await fetchText(rssUrl, 8000);
    const items = parseRssItems(xml).map((item) => classifyNews(item, code, name));
    return {
      ok: true,
      query,
      source: "Google News RSS",
      sourceUrl: rssUrl,
      generatedAt: new Date().toISOString(),
      items,
      note: items.length ? "新聞用標題與摘要做關聯判讀，仍需點開原文確認細節。" : "外部新聞源沒有回傳可判讀的新聞。",
    };
  } catch (err) {
    return {
      ok: false,
      query,
      source: "Google News RSS",
      sourceUrl: rssUrl,
      generatedAt: new Date().toISOString(),
      items: [],
      note: `新聞暫時無法載入：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function seededRandom(seed: string) {
  let x = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 17);
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function syntheticSeries(code: string, quote: { close: number; open?: number; high?: number; low?: number; volume?: number; date?: string }) {
  const rand = seededRandom(code);
  const n = 160;
  const close = quote.close;
  const start = close * (0.62 + rand() * 0.55);
  const trend = Math.log(close / start) / (n - 1);
  const closes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const cycle = Math.sin(i / 7.5) * 0.035 + Math.sin(i / 19) * 0.06;
    const noise = (rand() - 0.5) * 0.03;
    closes.push(round(Math.max(2, start * Math.exp(trend * i) * (1 + cycle + noise))));
  }
  closes[n - 1] = round(close);
  const highs = closes.map(c => round(c * (1.008 + rand() * 0.026)));
  const lows = closes.map(c => round(c * (0.992 - rand() * 0.024)));
  const volumes = closes.map((c, i) => Math.round((quote.volume || 2_200_000) * (0.55 + rand() * 1.15) * (1 + Math.abs(c - (closes[i - 1] || c)) / c * 6)));
  if (Number.isFinite(quote.open)) closes[n - 1] = round(close);
  if (Number.isFinite(quote.high)) highs[n - 1] = Math.max(highs[n - 1], quote.high as number);
  if (Number.isFinite(quote.low)) lows[n - 1] = Math.min(lows[n - 1], quote.low as number);
  if (Number.isFinite(quote.volume) && (quote.volume as number) > 0) volumes[n - 1] = quote.volume as number;
  const today = quote.date || new Date().toISOString().slice(0, 10);
  const end = new Date(`${today}T00:00:00Z`);
  return closes.map((c, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (n - 1 - i));
    return {
      date: d.toISOString().slice(0, 10),
      open: i === n - 1 && Number.isFinite(quote.open) ? quote.open as number : round((c + lows[i]) / 2),
      high: highs[i],
      low: lows[i],
      close: c,
      volume: volumes[i],
    };
  });
}

function sma(data: number[], n: number) {
  return data.map((_, i) => {
    const size = Math.min(i + 1, n);
    const slice = data.slice(i + 1 - size, i + 1);
    return round(slice.reduce((a, b) => a + b, 0) / size);
  });
}

function ema(data: number[], n: number) {
  const k = 2 / (n + 1);
  let prev = data[0];
  return data.map((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    return round(prev, 4);
  });
}

function std(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

function boll(data: number[], n = 20, mult = 2) {
  const mid = sma(data, n);
  const up: number[] = [];
  const low: number[] = [];
  const pctB: number[] = [];
  const bw: number[] = [];
  data.forEach((close, i) => {
    if (i + 1 < n) {
      up.push(NaN); low.push(NaN); pctB.push(NaN); bw.push(NaN); return;
    }
    const m = mid[i];
    const s = std(data.slice(i + 1 - n, i + 1));
    const u = m + mult * s;
    const l = m - mult * s;
    up.push(round(u));
    low.push(round(l));
    pctB.push(round((close - l) / (u - l), 3));
    bw.push(round(((u - l) / m) * 100));
  });
  return { mid, up, low, pctB, bw };
}

function rsi(data: number[], n = 14) {
  return data.map((_, i) => {
    if (i < n) return NaN;
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

function kd(closes: number[], highs: number[], lows: number[], n = 9) {
  const k: number[] = [];
  const d: number[] = [];
  let prevK = 50;
  let prevD = 50;
  closes.forEach((close, i) => {
    if (i + 1 < n) {
      k.push(NaN); d.push(NaN); return;
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

function lastFinite(values: number[]) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return NaN;
}

function buildAnalysis(series: DailyBar[], week52High: number, week52Low: number) {
  const closes = series.map(row => row.close);
  const highs = series.map(row => row.high);
  const lows = series.map(row => row.low);
  const volumes = series.map(row => row.volume || 0);
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
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, volumes.length));
  const volumeRatio = avgVol20 > 0 ? round(volumes[volumes.length - 1] / avgVol20) : 1;
  const supportShort = Math.min(...lows.slice(-20));
  const supportMid = Math.min(...lows.slice(-60));
  const resistanceShort = Math.max(...highs.slice(-20));
  const resistanceMid = Math.max(...highs.slice(-60));
  const rsiNow = lastFinite(rsi14);
  const kNow = lastFinite(kdData.k);
  const dNow = lastFinite(kdData.d);
  const pctBNow = lastFinite(bb.pctB);
  const ma20Now = lastFinite(ma20);
  const ma60Now = lastFinite(ma60);
  const ma120Now = lastFinite(ma120);
  const gap120 = Number.isFinite(ma120Now) ? ((close / ma120Now) - 1) * 100 : 0;
  let score = 25;
  if (rsiNow > 70) score += 20; else if (rsiNow > 60) score += 10; else if (rsiNow < 40) score -= 8;
  if (gap120 > 40) score += 15; else if (gap120 > 22) score += 8;
  if (pctBNow > 0.85) score += 10;
  if (volumeRatio > 1.8) score += 15; else if (volumeRatio > 1.25) score += 8;
  if (hist[hist.length - 1] < hist[Math.max(0, hist.length - 3)]) score += 10;
  if (close > resistanceShort * 0.96) score += 10;
  if (ma20Now > ma60Now && close > ma120Now) score -= 10;
  const pullback = Math.max(15, Math.min(95, Math.round(score)));

  return {
    labels: series.map(row => row.date),
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
      bandwidth: lastFinite(bb.bw),
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

async function loadQuote(code: string): Promise<QuoteInfo> {
  let chart: Awaited<ReturnType<typeof fetchYahooChart>> | null = null;
  let realtime: Awaited<ReturnType<typeof fetchTwseMis>> | null = null;
  let snapshot: Awaited<ReturnType<typeof fetchExchangeSnapshot>> | null = null;
  const sourceNotes: string[] = [];

  try {
    chart = await fetchYahooChart(code);
  } catch (err) {
    sourceNotes.push(`Yahoo daily failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (/^\d+$/.test(code)) {
    try {
      realtime = await fetchTwseMis(code);
    } catch (err) {
      sourceNotes.push(`TWSE MIS failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!realtime) {
      try {
        snapshot = await fetchExchangeSnapshot(code);
      } catch (err) {
        sourceNotes.push(`Exchange snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!chart && !realtime && !snapshot) {
    throw new Error(sourceNotes.join("; ") || "No quote source returned data");
  }

  const quoteAnchor = realtime || snapshot;
  const series = chart ? chart.bars.slice(-160) : syntheticSeries(code, quoteAnchor!);
  if (quoteAnchor && Number.isFinite(quoteAnchor.close)) {
    const last = series[series.length - 1];
    last.close = quoteAnchor.close;
    if (Number.isFinite(quoteAnchor.open)) last.open = quoteAnchor.open;
    if (Number.isFinite(quoteAnchor.high)) last.high = Math.max(last.high, quoteAnchor.high);
    if (Number.isFinite(quoteAnchor.low)) last.low = Math.min(last.low, quoteAnchor.low);
    if (Number.isFinite(quoteAnchor.volume) && quoteAnchor.volume > 0) last.volume = quoteAnchor.volume;
    if (quoteAnchor.date) last.date = quoteAnchor.date;
  }

  const week52High = chart?.week52High ?? Math.max(...series.map(row => row.high));
  const week52Low = chart?.week52Low ?? Math.min(...series.map(row => row.low));
  const analysis = buildAnalysis(series, week52High, week52Low);
  const close = analysis.latest.close;
  const previousClose = realtime?.previousClose || series[series.length - 2]?.close;
  const change = Number.isFinite(previousClose) && Number.isFinite(close) ? close - previousClose : snapshot?.change ?? null;

  const source = chart && realtime
    ? "Yahoo Finance daily OHLCV + TWSE MIS latest quote"
    : chart
      ? "Yahoo Finance daily OHLCV"
      : "Exchange latest quote + reconstructed analysis path";

  return {
    code,
    symbol: chart?.symbol || `${code}.TW`,
    name: quoteAnchor?.name || chart?.name || FALLBACK_NAMES[code] || code,
    market: quoteAnchor?.market || chart?.market || "TWSE/OTC",
    currency: chart?.currency || "TWD",
    close,
    open: series[series.length - 1].open,
    high: series[series.length - 1].high,
    low: series[series.length - 1].low,
    change: Number.isFinite(change) ? round(change as number) : null,
    volume: series[series.length - 1].volume,
    source: sourceNotes.length ? `${source}; fallback notes available` : source,
    sourceUrls: {
      yahoo: chart?.sourceUrl || null,
      twseMis: realtime?.sourceUrl || null,
      exchange: snapshot?.sourceUrl || null,
      goodinfo: `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}`,
    },
    series,
    analysis,
  };
}

function fmt(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function buildAgentReply(quote: QuoteInfo, question: string) {
  const q = question.trim() || "請給我目前風險與操作建議";
  const latest = quote.analysis.latest;
  const levels = quote.analysis.levels;
  const prob = quote.analysis.probabilities;
  const close = latest.close;
  const stop = levels.supportMid * 0.97;
  const target1 = levels.resistanceShort * 1.04;
  const target2 = latest.week52High * 1.06;
  const trendUp = close > latest.ma20 && latest.ma20 > latest.ma60;
  const highRisk = latest.pullback >= 70;
  const tone = highRisk ? "bear" : trendUp ? "bull" : "neutral";
  const stance = highRisk ? "高風險" : trendUp ? "偏多" : "觀察";

  return {
    title: `${quote.code} ${quote.name} Agent 回覆`,
    stance,
    tone,
    confidence: Math.max(45, Math.min(88, 100 - Math.abs(latest.pullback - 50))),
    question: q,
    answer: `目前收盤 ${fmt(close)}，回檔機率 ${latest.pullback}%。短線支撐 ${fmt(levels.supportShort)}，中線支撐 ${fmt(levels.supportMid)}，短線壓力 ${fmt(levels.resistanceShort)}。${highRisk ? "不建議追高，等回測或量縮整理較好。" : trendUp ? "趨勢仍偏多，但進場仍需分批。" : "目前以觀察和控風險為主。"}`,
    keyPoints: [
      `均線：MA20 ${fmt(latest.ma20)}、MA60 ${fmt(latest.ma60)}、MA120 ${fmt(latest.ma120)}。`,
      `指標：RSI14 ${fmt(latest.rsi14, 1)}、KD ${fmt(latest.k, 1)} / ${fmt(latest.d, 1)}、MACD Hist ${fmt(latest.hist, 3)}。`,
      `機率：整體 ${prob.overall}%、技術 ${prob.technical}%、量能 ${prob.volume}%、波段 ${prob.wave}%。`,
    ],
    actions: [
      `第一觀察買點：${fmt(levels.supportShort * 0.99)} - ${fmt(levels.supportShort * 1.01)}。`,
      `第二分批買點：${fmt(levels.supportMid * 0.99)} - ${fmt(levels.supportMid * 1.02)}。`,
      `停損：${fmt(stop)}；目標：${fmt(target1)} / ${fmt(target2)}。`,
    ],
    watchlist: [
      "若跌破 MA20 且無法收回，短線結構轉弱。",
      "若突破壓力但量能沒有放大，容易是假突破。",
      "若 RSI 維持 70 以上，代表強勢但追價風險同步升高。",
    ],
    disclaimer: "本頁為技術分析與情境推估工具，不構成投資建議。",
    generatedAt: new Date().toISOString(),
  };
}

export const handler = router({
  "GET /api/_healthcheck": [async () => json({ message: "Success" })],

  "GET /api/quote": [async ({ query }) => {
    const code = cleanCode(query.code);
    if (!code) return error("Missing stock code", 400);
    try {
      return json({ ok: true, quote: await loadQuote(code), generatedAt: new Date().toISOString() });
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to load quote data for ${code}: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/agent": [async ({ query }) => {
    const code = cleanCode(query.code);
    const question = String(query.question || "").slice(0, 500);
    if (!code) return error("Missing stock code", 400);
    try {
      const quote = await loadQuote(code);
      return json({
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
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to run analysis agent for ${code}: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/news": [async ({ query }) => {
    const code = cleanCode(query.code);
    const name = String(query.name || FALLBACK_NAMES[code] || code).slice(0, 40);
    if (!code) return error("Missing stock code", 400);
    return json(await loadNews(code, name));
  }],
});
