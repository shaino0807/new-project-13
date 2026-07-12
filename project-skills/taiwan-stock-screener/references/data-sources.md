# Data Sources

Preferred sources:

- TWSE OpenAPI: `https://openapi.twse.com.tw/v1/swagger.json`
- TWSE current daily prices: `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`
- TWSE current dividend yield: `https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL`
- TPEx daily quotes: `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes`
- TPEx daily P/E and dividend yield: `https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate`
- TPEx institutional trading: `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade`
- TPEx turnover ranking: `https://www.tpex.org.tw/web/stock/aftertrading/daily_turnover/trn_result.php`
- FinMind API: `https://api.finmindtrade.com/api/v4/data`

Operational note:

FinMind may return `ip banned` after aggressive batch querying. Use low concurrency, cache responses, and stop immediately when a ban or rate-limit response appears.
