---
name: kline-long-short-signal
description: Use this skill when analyzing a latest K-line/candlestick chart image or chart data for a stock, index, futures, crypto, or other tradable instrument to identify actionable long, short, or no-trade signals based on support/resistance boxes, trend channels, breakout/fakeout behavior, N-shaped moves, candlestick reversal strength, volume, and multi-timeframe confirmation. Trigger when the user asks for K棒, K線, candlestick, 做多, 做空, 多空信號, 進場點, 停損, 支撐壓力, or latest chart signal analysis.
metadata:
  short-description: Analyze K-line charts for long/short signals
---

# K-Line Long/Short Signal

## Purpose

Analyze the latest available K-line/candlestick chart and decide whether it shows a long signal, short signal, or no-trade condition. This is chart-pattern analysis, not financial advice.

## Required Inputs

Use any available input:

- A chart image supplied by the user.
- Current chart data or screenshots retrieved from an available tool/source.
- If the user only gives a ticker/symbol, first determine the market and timeframe. If the latest chart cannot be accessed reliably, ask for a chart image or chart source.

Always state the chart timeframe and data freshness. If unclear, mark it as an assumption.

## Analysis Workflow

1. Identify context:
   - Instrument, timeframe, timestamp/session if visible.
   - Current price area.
   - Overall trend: rising, falling, range-bound, or transition.

2. Mark key areas:
   - Recent high/low.
   - Support/resistance zones.
   - Consolidation boxes.
   - Trend channel or trendline.
   - Moving average cluster if visible.
   - Large candle zones, gaps, and high-volume bars.

3. Read the latest candles:
   - Body direction and size.
   - Upper/lower wick rejection.
   - Close location relative to support/resistance.
   - Breakout, breakdown, fakeout, or reclaim.
   - Volume expansion or failure if volume is visible.

4. Check multi-timeframe agreement when available:
   - Higher timeframe gives direction and major zones.
   - Lower timeframe gives entry trigger.
   - Do not treat a lower-timeframe signal as strong if it fights a clear higher-timeframe pressure zone without confirmation.

5. Decide:
   - Long setup.
   - Short setup.
   - No trade / wait for confirmation.

## Long Signals

Prefer long only when price is near support or reclaiming strength. Stronger long setups require at least two confirming items.

- Support rejection: price tests a support box, prior low, or channel bottom and forms a lower wick, bullish candle, or bullish engulfing candle.
- Fake breakdown reclaim: price breaks below support but quickly closes back above the support/box.
- N-shaped reversal: price falls, rebounds, pulls back without breaking the prior low, then breaks the minor swing high.
- Downtrend break: price breaks a descending trendline/channel, then retests it without falling back below.
- Resistance becomes support: price breaks a resistance box, pulls back, and holds above it.
- Long bullish candle through pressure: a strong candle breaks resistance, prior high, or moving-average cluster. Avoid chasing; prefer retest.
- Short-covering strength: a failed bearish attack is followed by rapid bullish candles or a strong reclaim.
- Measured-move completion: a decline reaches a 1:1 or expected downside target, stops extending, and forms a reversal signal.

Long trigger examples:

- Enter after a bullish candle closes back above support.
- Enter after retest of reclaimed support holds.
- Enter on break of the minor high after an N-shaped base.
- Stop below the signal candle low, support box low, or failed reclaim low.

## Short Signals

Prefer short only when price is near resistance or losing structure. Stronger short setups require at least two confirming items.

- Resistance rejection: price tests a resistance box, prior high, or channel top and forms an upper wick, bearish candle, or bearish engulfing candle.
- Fake breakout failure: price breaks above resistance but quickly closes back below the resistance/box.
- Uptrend break: price breaks an ascending trendline/channel, then retests it and fails to reclaim.
- Support breakdown: a strong bearish candle breaks support, prior low, or moving-average cluster.
- Long-stop cascade: support breaks and price does not reclaim, suggesting trapped longs are forced out.
- Weak bounce: after a decline, price bounces but cannot exceed the prior swing high, moving average, or pressure zone.
- Falls back into box: price was expected to continue higher but drops back into the consolidation box, making the box top resistance.
- Bullish force exhaustion: after a long bullish run, price stalls with upper wicks, small bodies, reduced volume, or a reversal candle.

Short trigger examples:

- Enter after a bearish candle closes below resistance or support.
- Enter after failed retest of broken support.
- Enter on break of the minor low after a failed bounce.
- Stop above the signal candle high, resistance box high, or fake breakout high.

## No-Trade Conditions

Return "觀望" when:

- Price is in the middle of a range without clear support/resistance interaction.
- The latest candle is unfinished and signal depends on its close.
- Long and short signals conflict with similar strength.
- The chart is too blurry, cropped, or lacks enough recent candles.
- The setup requires chasing a large candle far from a logical stop.
- Risk/reward is poor: stop distance is large relative to the next support/resistance target.

## Signal Strength

Classify confidence:

- High: clear key zone + decisive candle close + retest or multi-timeframe agreement + acceptable stop.
- Medium: clear key zone + one decisive candle, but no retest yet.
- Low: early reversal hint, unclear zone, weak volume, or chart quality limitations.

Use "wait for confirmation" for low-confidence setups rather than forcing a trade.

## Output Format

Respond in Traditional Chinese unless the user asks otherwise.

Use this structure:

```markdown
**結論**
方向：做多 / 做空 / 觀望
信號強度：高 / 中 / 低
時間框架：...
資料時間：...

**觸發信號**
- ...

**進場條件**
- ...

**停損/失效**
- ...

**目標/壓力支撐**
- ...

**為什麼不是反方向**
- ...

**風險提醒**
這是技術圖形判讀，不是投資建議；實際交易需自行控管部位與風險。
```

## Decision Rules

- Do not call a long signal only because a candle is red/up; location and close matter more than color.
- Do not call a short signal only because a candle is green/down; location and close matter more than color.
- Treat fakeout/reclaim as stronger than the initial breakout/breakdown.
- Prefer entries after confirmation or retest when the candle has already moved far from the stop.
- Always name the invalidation level or structure. If no logical invalidation exists, return no trade.
- If the user asks for the "latest" chart or signal and no current chart is supplied, use current data/chart sources when available; otherwise state that the latest chart was not accessible and ask for an updated image.
