-- Backfill exit scores for closed trades that were finalized without one.
-- 11 are EOD sweeps from 2026-07-30/31 (the sweep left exit_fill null and no
-- broker patch arrived); 3 are MANUAL_CLOSE rows from May. Exit price is the
-- last 1m candle close at or before each trade's end_ts, matching the live
-- scoring convention (bar price, no slippage).
-- Run with the app STOPPED:
--   sqlite3 data/trading-agent.sqlite < scripts/backfill-exit-scores-2026-07-31.sql
BEGIN;
-- NVDA LONG MANUAL_CLOSE -> exit 235.64, +1.2265%  (candle 36s before close)
UPDATE outcomes SET exit_fill=235.64, exit_return_pct=1.2265 WHERE alert_id='60805c696127832c7e5ac97d' AND exit_return_pct IS NULL;
-- IWM LONG MANUAL_CLOSE -> exit 282.48, +0.8245%  (candle 4658s before close)
UPDATE outcomes SET exit_fill=282.48, exit_return_pct=0.8245 WHERE alert_id='43a98be396e14fc3b7a8473e' AND exit_return_pct IS NULL;
-- MU LONG MANUAL_CLOSE -> exit 758.63, +0.0858%  (candle 1070s before close)
UPDATE outcomes SET exit_fill=758.63, exit_return_pct=0.0858 WHERE alert_id='8429800ec1a6555314d8f861' AND exit_return_pct IS NULL;
-- AVGO LONG EOD -> exit 385.49, +1.5431%  (candle 0s before close)
UPDATE outcomes SET exit_fill=385.49, exit_return_pct=1.5431 WHERE alert_id='76fe6cd6c16ee56926f245d3' AND exit_return_pct IS NULL;
-- QQQ LONG EOD -> exit 681.98, +0.504%  (candle 0s before close)
UPDATE outcomes SET exit_fill=681.98, exit_return_pct=0.504 WHERE alert_id='c5abb089378796386622b03b' AND exit_return_pct IS NULL;
-- TSLA LONG EOD -> exit 307.8, +0.631%  (candle 0s before close)
UPDATE outcomes SET exit_fill=307.8, exit_return_pct=0.631 WHERE alert_id='497f49afe544b661c134177a' AND exit_return_pct IS NULL;
-- AMZN LONG EOD -> exit 237.76, +0.5073%  (candle 0s before close)
UPDATE outcomes SET exit_fill=237.76, exit_return_pct=0.5073 WHERE alert_id='815e2a23c689a637e73d7594' AND exit_return_pct IS NULL;
-- AVGO LONG EOD -> exit 385.49, +0.2888%  (candle 0s before close)
UPDATE outcomes SET exit_fill=385.49, exit_return_pct=0.2888 WHERE alert_id='b805d07280a79c46d9b9e615' AND exit_return_pct IS NULL;
-- IWM LONG EOD -> exit 291.72, +0.244%  (candle 0s before close)
UPDATE outcomes SET exit_fill=291.72, exit_return_pct=0.244 WHERE alert_id='0ca280f1641c870aa0c743c9' AND exit_return_pct IS NULL;
-- QQQ LONG EOD -> exit 681.98, +0.138%  (candle 0s before close)
UPDATE outcomes SET exit_fill=681.98, exit_return_pct=0.138 WHERE alert_id='4ae30a674898fcc1796bcb5f' AND exit_return_pct IS NULL;
-- AMZN LONG EOD -> exit 237.76, -0.0294%  (candle 0s before close)
UPDATE outcomes SET exit_fill=237.76, exit_return_pct=-0.0294 WHERE alert_id='d1fb0d92bfe31f5527cab984' AND exit_return_pct IS NULL;
-- QQQ LONG EOD -> exit 681.98, -0.0132%  (candle 0s before close)
UPDATE outcomes SET exit_fill=681.98, exit_return_pct=-0.0132 WHERE alert_id='0ee9ef2203764d91851c51b0' AND exit_return_pct IS NULL;
-- AMZN LONG EOD -> exit 237.76, +0.5668%  (candle 0s before close)
UPDATE outcomes SET exit_fill=237.76, exit_return_pct=0.5668 WHERE alert_id='404ee9a6146486e0edeff2d5' AND exit_return_pct IS NULL;
-- AAPL SHORT EOD -> exit 302.575, +0.7235%  (candle 0s before close)
UPDATE outcomes SET exit_fill=302.575, exit_return_pct=0.7235 WHERE alert_id='de91ac8485266f4584513d84' AND exit_return_pct IS NULL;
COMMIT;
