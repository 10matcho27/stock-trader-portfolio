/* 運用状況ページ。data/portfolio.json を 1 回読んで描くだけの read-only なページ。
   外部依存なし。パスはすべて相対（GitHub Pages の project site 配下で配信されるため）。 */
(function () {
  'use strict';

  var JST = 9 * 3600000;
  var SLOT_MIN = [11 * 60 + 35, 15 * 60 + 5];   /* 平日 11:35 / 15:05 JST */
  var GRACE_MS = 2 * 3600000;                   /* 想定更新から 2 時間で警告 */
  var MISS = '取得できていません';
  var WEEK = '日月火水木金土';

  /* detail_level ごとに「本来あるはずの欄」。ここに無い欄は、
     欠けていても取得失敗ではなく方針による非開示なので、列ごと描かない。 */
  var EXPECT = {
    full: {
      summary: ['initial_cash', 'cash', 'holding_value', 'total_assets', 'realized_pnl',
                'unrealized_pnl', 'total_pnl', 'total_return_pct', 'position_count'],
      position: ['qty', 'avg_cost', 'last_price', 'market_value', 'unrealized_pnl', 'unrealized_pct']
    },
    restricted: {
      summary: ['total_return_pct', 'position_count'],
      position: ['unrealized_pct']
    }
  };
  /* 現在値に依存する欄。valuation_available: false のときだけ「取得できていません」と書く。 */
  var VALUATION_DEPENDENT = {
    holding_value: 1, total_assets: 1, unrealized_pnl: 1, total_pnl: 1, total_return_pct: 1,
    last_price: 1, market_value: 1, unrealized_pct: 1
  };

  /* ---------- 小道具 ---------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function show(node, on) { node.hidden = !on; }
  function has(v) { return v !== undefined && v !== null; }
  function num(v) { return typeof v === 'number' && isFinite(v); }

  function grp(n) { return Math.round(n).toLocaleString('en-US'); }
  function yen(n) { return '¥' + grp(n); }
  function yenExact(n) { return '¥' + n.toLocaleString('en-US'); }
  function syen(n) { return (n >= 0 ? '+' : '-') + '¥' + grp(Math.abs(n)); }
  function pctText(n) { return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2) + '%'; }
  function ptText(n) { return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2) + 'pt'; }
  function markOf(n) { return n > 0 ? '▲' : (n < 0 ? '▼' : '■'); }
  function toneOf(n) { return n > 0 ? 'up' : (n < 0 ? 'down' : 'flat'); }
  function man(n) { return '¥' + grp(n / 10000) + '万'; }

  function ms(iso) { var t = new Date(iso).getTime(); return isFinite(t) ? t : null; }
  function jp(t) {
    var x = new Date(t + JST);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(),
             w: x.getUTCDay(), h: x.getUTCHours(), i: x.getUTCMinutes() };
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(t) {
    var p = jp(t);
    return p.y + '-' + p2(p.m) + '-' + p2(p.d) + '(' + WEEK.charAt(p.w) + ') ' + p2(p.h) + ':' + p2(p.i) + ' JST';
  }
  function dayLabel(t) { var p = jp(t); return p.y + '-' + p2(p.m) + '-' + p2(p.d); }
  function shortStamp(t) { var p = jp(t); return p2(p.m) + '-' + p2(p.d) + ' ' + p2(p.h) + ':' + p2(p.i); }
  function dnum(s) {
    var a = String(s).split('-');
    var t = Date.UTC(+a[0], (+a[1]) - 1, +a[2]);
    return isFinite(t) ? t : null;
  }
  function minusMonths(t, m) {
    var x = new Date(t);
    x.setUTCMonth(x.getUTCMonth() - m);
    return x.getTime();
  }

  /* ---------- staleness ---------- */

  function dayStart(t) { var x = new Date(t + JST); x.setUTCHours(0, 0, 0, 0); return x.getTime() - JST; }

  /* now 以前の更新スロットを新しい順に返す。土日は数えないので週末に警告が出っぱなしにならない。 */
  function slotsBefore(now, limit) {
    var out = [], day = dayStart(now), guard = 0;
    while (out.length < limit && guard < 60) {
      var w = jp(day).w;
      if (w >= 1 && w <= 5) {
        for (var k = SLOT_MIN.length - 1; k >= 0; k--) {
          var t = day + SLOT_MIN[k] * 60000;
          if (t <= now && out.length < limit) { out.push(t); }
        }
      }
      day -= 86400000;
      guard++;
    }
    return out;
  }

  function staleness(generatedAt, now) {
    if (generatedAt === null) { return { stale: false, missed: 0, ageH: 0 }; }
    var grace = slotsBefore(now - GRACE_MS, 1)[0];
    if (grace === undefined || generatedAt >= grace) { return { stale: false, missed: 0, ageH: 0 }; }
    var missed = 0, all = slotsBefore(now, 40);
    for (var i = 0; i < all.length; i++) { if (all[i] > generatedAt) { missed++; } }
    return { stale: true, missed: missed, ageH: Math.floor((now - generatedAt) / 3600000) };
  }

  /* ---------- 欠損の描き分け ---------- */

  /* 値があれば整形して返す。無いときは、この detail_level で本来あるはずの
     現在値依存の欄だけ「取得できていません」を返し、それ以外は null（＝列ごと描かない）。 */
  function fieldOf(obj, key, fmt, tone, kind, level, valuationAvailable) {
    var v = obj ? obj[key] : undefined;
    if (num(v)) { return { text: fmt(v), cls: tone ? toneOf(v) : '', miss: false }; }
    var expect = (level === 'full' ? EXPECT.full : EXPECT.restricted)[kind];
    if (expect.indexOf(key) < 0) { return null; }
    if (VALUATION_DEPENDENT[key] && valuationAvailable === false) {
      return { text: MISS, cls: 'miss', miss: true };
    }
    return null;
  }

  /* ---------- 描画: ヘッダとバナー ---------- */

  function renderHead(d, now) {
    var gen = d.generated_at ? ms(d.generated_at) : null;
    var st = staleness(gen, now);
    $('genAt').textContent = gen === null ? '不明' : stamp(gen);
    $('freshDot').className = 'dot' + (gen === null ? ' is-unknown' : (st.stale ? ' is-stale' : ''));
    $('srcLabel').textContent = 'source: ' + (d.source || '—');
    $('lvlLabel').textContent = 'detail: ' + (d.detail_level || 'full');
    return st;
  }

  function banner(kind, title, body) {
    var b = el('div', 'banner' + (kind === 'warn' ? ' is-warn' : ''));
    b.setAttribute('role', 'status');
    var icon = el('span', 'banner-icon', kind === 'warn' ? '!' : 'i');
    icon.setAttribute('aria-hidden', 'true');
    var box = el('div');
    box.appendChild(el('p', 'banner-title', title));
    box.appendChild(el('p', 'banner-body', body));
    b.appendChild(icon);
    b.appendChild(box);
    return b;
  }

  function renderBanners(d, st, gen) {
    var host = $('banners');
    clear(host);
    if (st.stale) {
      host.appendChild(banner('warn', 'データが更新されていません',
        '最終更新は ' + (gen === null ? '不明' : stamp(gen)) + '（約 ' + st.ageH + ' 時間前）。' +
        '想定していた更新 ' + st.missed + ' 回分が届いていません。bot の停止か認証切れの可能性があります。'));
    }
    if (d.source === 'file_fallback') {
      host.appendChild(banner('info', 'フォールバックで生成',
        'bot 本体に接続できず、保存済みファイルから作られた内容です。数値が最新でない可能性があります。'));
    }
    var notes = Array.isArray(d.notes) ? d.notes : [];
    for (var i = 0; i < notes.length; i++) { host.appendChild(banner('info', '注意', String(notes[i]))); }
  }

  /* ---------- 描画: サマリ ---------- */

  function renderSummary(d) {
    var s = d.summary || {};
    var level = d.detail_level === 'symbols_only' || d.detail_level === 'summary' ? d.detail_level : 'full';
    var va = d.valuation_available;

    var hero = fieldOf(s, 'total_return_pct', pctText, true, 'summary', level, va);
    var markEl = $('heroMark'), valEl = $('heroVal'), ruleEl = $('heroRule');
    if (hero && !hero.miss) {
      markEl.textContent = markOf(s.total_return_pct);
      markEl.className = 'hero-mark ' + hero.cls;
      valEl.textContent = hero.text;
      valEl.className = 'hero-val ' + hero.cls;
      ruleEl.className = 'rule ' + hero.cls;
      ruleEl.hidden = false;
    } else {
      markEl.textContent = '';
      markEl.className = 'hero-mark';
      valEl.textContent = MISS;
      valEl.className = 'hero-val is-miss';
      ruleEl.hidden = true;
    }

    var tiles = $('tiles');
    clear(tiles);
    function tile(label, key, fmt, tone) {
      var f = fieldOf(s, key, fmt, tone, 'summary', level, va);
      if (!f) { return; }
      var box = el('div', 'tile');
      box.appendChild(el('p', 'tile-label', label));
      var v = el('p', 'tile-val ' + f.cls + (f.miss ? ' is-miss' : ''), f.text);
      box.appendChild(v);
      tiles.appendChild(box);
    }
    tile('総資産', 'total_assets', yen, false);
    tile('株式評価額', 'holding_value', yen, false);
    tile('確定損益', 'realized_pnl', syen, true);
    tile('評価損益', 'unrealized_pnl', syen, true);
    tile('現金', 'cash', yen, false);
    if (num(s.position_count)) {
      var box = el('div', 'tile');
      box.appendChild(el('p', 'tile-label', '保有銘柄数'));
      box.appendChild(el('p', 'tile-val', s.position_count + ' 銘柄'));
      tiles.appendChild(box);
    }
  }

  /* ---------- 描画: 保有銘柄 ---------- */

  function renderPositions(d) {
    var sec = $('sec-positions');
    if (!Array.isArray(d.positions)) { show(sec, false); return; }
    show(sec, true);

    var level = d.detail_level === 'symbols_only' || d.detail_level === 'summary' ? d.detail_level : 'full';
    var va = d.valuation_available;
    var list = $('posList');
    clear(list);
    $('posCount').textContent = d.positions.length + ' 銘柄';
    show($('posEmpty'), d.positions.length === 0);

    for (var i = 0; i < d.positions.length; i++) {
      var p = d.positions[i];
      var card = el('article', 'pos');

      var left = el('div');
      var top = el('div', 'pos-top');
      top.appendChild(el('span', 'pos-ticker', p.ticker || '—'));

      var pf = fieldOf(p, 'unrealized_pct', pctText, true, 'position', level, va);
      if (pf) {
        var pctBox = el('span', 'pos-pct ' + pf.cls + (pf.miss ? ' is-miss' : ''));
        if (!pf.miss) {
          var m = el('span', 'm', markOf(p.unrealized_pct));
          m.setAttribute('aria-hidden', 'true');
          pctBox.appendChild(m);
        }
        pctBox.appendChild(document.createTextNode(pf.text));
        top.appendChild(pctBox);
      }
      left.appendChild(top);

      left.appendChild(el('h3', 'pos-name', p.company_name || ''));
      var entered = p.entered_at ? ms(p.entered_at) : null;
      var sub = [p.sector, entered === null ? null : dayLabel(entered) + ' から保有']
        .filter(function (x) { return x; }).join(' · ');
      if (sub) { left.appendChild(el('p', 'pos-sub', sub)); }

      var metrics = el('div', 'metrics');
      var rows = [
        ['数量', 'qty', function (v) { return grp(v) + ' 株'; }, false],
        ['平均取得単価', 'avg_cost', yenExact, false],
        ['現在値', 'last_price', yenExact, false],
        ['評価額', 'market_value', yen, false],
        ['評価損益', 'unrealized_pnl', syen, true]
      ];
      var shown = 0;
      for (var r = 0; r < rows.length; r++) {
        var f = fieldOf(p, rows[r][1], rows[r][2], rows[r][3], 'position', level, va);
        if (!f) { continue; }
        var row = el('div', 'metric');
        row.appendChild(el('span', 'metric-label', rows[r][0]));
        row.appendChild(el('span', 'metric-val ' + f.cls + (f.miss ? ' is-miss' : ''), f.text));
        metrics.appendChild(row);
        shown++;
      }
      if (shown) { left.appendChild(metrics); }
      card.appendChild(left);

      var why = el('div', 'pos-why');
      var w1 = el('div');
      w1.appendChild(el('p', 'why-lbl', 'なぜ買ったか'));
      w1.appendChild(el('p', 'why-txt', p.entry_catalyst || '—'));
      why.appendChild(w1);
      var w2 = el('div', 'why-2');
      w2.appendChild(el('p', 'why-lbl', 'なぜまだ持っているか'));
      w2.appendChild(el('p', 'why-txt', p.hold_rationale || '—'));
      why.appendChild(w2);
      card.appendChild(why);

      list.appendChild(card);
    }
  }

  /* ---------- 描画: 直近の約定 ---------- */

  function renderTrades(d) {
    var sec = $('sec-trades');
    if (!Array.isArray(d.recent_trades)) { show(sec, false); return; }
    show(sec, true);

    var list = $('tradeList');
    clear(list);
    show($('tradeEmpty'), d.recent_trades.length === 0);

    for (var i = 0; i < d.recent_trades.length; i++) {
      var t = d.recent_trades[i];
      var buy = t.side === 'BUY';
      var li = el('li', 'trade');
      li.appendChild(el('span', 'trade-side' + (buy ? ' is-buy' : ''), buy ? 'BUY' : 'SELL'));
      li.appendChild(el('span', 'trade-tk', t.ticker || '—'));
      var bits = [];
      if (num(t.qty)) { bits.push(grp(t.qty) + ' 株'); }
      if (num(t.price)) { bits.push('@' + yenExact(t.price)); }
      li.appendChild(el('span', 'trade-detail', bits.join('  ')));
      var tt = t.time ? ms(t.time) : null;
      li.appendChild(el('span', 'trade-time', tt === null ? '—' : shortStamp(tt)));
      list.appendChild(li);
    }
  }

  /* ---------- 描画: グラフ ---------- */

  var VB_W = 720, VB_H = 240, PAD_X = 6, PAD_Y = 14;
  var chartState = null;

  function xAt(i, n) { return n === 1 ? VB_W / 2 : PAD_X + i * (VB_W - 2 * PAD_X) / (n - 1); }
  function yAt(v, lo, hi) { return VB_H - PAD_Y - (v - lo) / (hi - lo) * (VB_H - 2 * PAD_Y); }

  function linePath(vals, lo, hi) {
    var n = vals.length, out = '';
    if (n === 1) {
      var y = yAt(vals[0], lo, hi).toFixed(1);
      return 'M' + (VB_W / 2 - 46) + ' ' + y + ' L' + (VB_W / 2 + 46) + ' ' + y;
    }
    for (var i = 0; i < n; i++) {
      out += (i ? ' L' : 'M') + xAt(i, n).toFixed(1) + ' ' + yAt(vals[i], lo, hi).toFixed(1);
    }
    return out;
  }

  function prepareChart(d) {
    var curve = Array.isArray(d.equity_curve) ? d.equity_curve : [];
    var benches = Array.isArray(d.benchmarks) ? d.benchmarks.slice() : [];
    var level = d.detail_level === 'symbols_only' || d.detail_level === 'summary' ? d.detail_level : 'full';
    var hasIndex = curve.length > 0 && num(curve[0].index);
    var compare = benches.length > 0 && hasIndex;

    var defaults = d.ui_defaults || {};
    var visible = {};
    var wanted = Array.isArray(defaults.visible_benchmark_keys) ? defaults.visible_benchmark_keys : null;
    for (var i = 0; i < benches.length; i++) {
      /* ui_defaults に、取得に失敗して存在しない key が残っていることがある。無視してよい。 */
      visible[benches[i].key] = wanted ? wanted.indexOf(benches[i].key) >= 0 : true;
    }
    var range = defaults.range === '3m' || defaults.range === '1m' ? defaults.range : 'all';

    chartState = {
      curve: curve, benches: benches, level: level, compare: compare,
      visible: visible, range: range, invested: d.invested_ratio_pct
    };
    buildLegend();
    show($('ranges'), compare);
    var btns = $('ranges').querySelectorAll('.seg-opt');
    for (var b = 0; b < btns.length; b++) {
      btns[b].setAttribute('aria-pressed', String(btns[b].getAttribute('data-range') === range));
    }
    drawChart();
  }

  function seriesMap(bench) {
    var map = {}, s = Array.isArray(bench.series) ? bench.series : [];
    for (var i = 0; i < s.length; i++) { if (num(s[i].index)) { map[s[i].date] = s[i].index; } }
    return map;
  }

  function visibleBenches() {
    var out = [];
    for (var i = 0; i < chartState.benches.length; i++) {
      var b = chartState.benches[i];
      if (chartState.visible[b.key]) { out.push({ bench: b, slot: i % 4, map: seriesMap(b) }); }
    }
    return out;
  }

  /* 選んだ期間の最初の日を 100 として引き直す。口座と指数は必ず同じ日を起点にする。 */
  function computeSeries() {
    var cs = chartState, curve = cs.curve;
    if (!curve.length) { return null; }

    var vis = cs.compare ? visibleBenches() : [];
    var lastT = dnum(curve[curve.length - 1].date);
    var from = -Infinity;
    if (cs.compare && cs.range === '3m') { from = minusMonths(lastT, 3); }
    if (cs.compare && cs.range === '1m') { from = minusMonths(lastT, 1); }

    var win = [];
    for (var i = 0; i < curve.length; i++) {
      var t = dnum(curve[i].date);
      if (t === null || t < from) { continue; }
      win.push(curve[i]);
    }
    if (!win.length) { return null; }

    if (!cs.compare) {
      var raw = [];
      for (var k = 0; k < win.length; k++) {
        if (!num(win[k].total_assets)) { continue; }
        raw.push({ date: win[k].date, v: win[k].total_assets });
      }
      if (!raw.length) { return null; }
      return {
        compare: false,
        dates: raw.map(function (p) { return p.date; }),
        account: raw.map(function (p) { return p.v; }),
        benches: [], unit: cs.level === 'full' ? 'yen' : 'index'
      };
    }

    /* 口座と、表示中のすべての指数に値がある最初の日まで起点を後ろへずらす。 */
    var start = -1;
    for (var a = 0; a < win.length && start < 0; a++) {
      if (!num(win[a].index)) { continue; }
      var okAll = true;
      for (var v = 0; v < vis.length; v++) { if (!num(vis[v].map[win[a].date])) { okAll = false; } }
      if (okAll) { start = a; }
    }
    if (start < 0) { return null; }

    var dates = [], acc = [], base = win[start].index;
    for (var j = start; j < win.length; j++) {
      if (!num(win[j].index)) { continue; }
      dates.push(win[j].date);
      acc.push(win[j].index / base * 100);
    }
    if (acc.length === 0) { return null; }

    var lines = [];
    for (var q = 0; q < vis.length; q++) {
      var bs = vis[q].map[dates[0]], vals = [];
      for (var r = 0; r < dates.length; r++) {
        var raw2 = vis[q].map[dates[r]];
        vals.push(num(raw2) ? raw2 / bs * 100 : null);
      }
      lines.push({ bench: vis[q].bench, slot: vis[q].slot, vals: vals });
    }
    return { compare: true, dates: dates, account: acc, benches: lines, unit: 'index' };
  }

  function drawChart() {
    var data = computeSeries();
    var frame = $('chartFrame'), empty = $('chartEmpty');
    if (!data) {
      show(frame, false);
      show($('xFirst').parentNode, false);
      show(empty, true);
      renderChartNotes(null);
      updateLegendValues(null);
      return;
    }
    show(empty, false);
    show(frame, true);
    show($('xFirst').parentNode, true);

    var all = data.account.slice();
    for (var i = 0; i < data.benches.length; i++) {
      for (var j = 0; j < data.benches[i].vals.length; j++) {
        if (num(data.benches[i].vals[j])) { all.push(data.benches[i].vals[j]); }
      }
    }
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { var e = Math.max(1, Math.abs(lo) * 0.02); hi = lo + e; lo -= e; }
    var pad = (hi - lo) * 0.16;
    hi += pad; lo -= pad;

    $('accountLine').setAttribute('d', linePath(data.account, lo, hi));

    var n = data.account.length;
    var areaD = '';
    if (n > 1) {
      areaD = linePath(data.account, lo, hi) +
        ' L' + xAt(n - 1, n).toFixed(1) + ' ' + VB_H + ' L' + xAt(0, n).toFixed(1) + ' ' + VB_H + ' Z';
    }
    $('area').setAttribute('d', areaD);

    var dot = $('accountDot');
    dot.setAttribute('cx', n === 1 ? String(VB_W / 2) : xAt(n - 1, n).toFixed(1));
    dot.setAttribute('cy', yAt(data.account[n - 1], lo, hi).toFixed(1));

    /* 指数の線。本数は決め打ちせず、要素を必要な数だけ複製する。 */
    var host = $('benchLines'), proto = host.querySelector('.proto');
    while (host.lastChild !== proto) { host.removeChild(host.lastChild); }
    for (var b = 0; b < data.benches.length; b++) {
      var vals = data.benches[b].vals, segs = [], cur = [];
      for (var v = 0; v < vals.length; v++) {
        if (num(vals[v])) { cur.push({ i: v, v: vals[v] }); }
        else if (cur.length) { segs.push(cur); cur = []; }
      }
      if (cur.length) { segs.push(cur); }
      var dStr = '';
      for (var s = 0; s < segs.length; s++) {
        for (var t = 0; t < segs[s].length; t++) {
          dStr += (t ? ' L' : ' M') + xAt(segs[s][t].i, vals.length).toFixed(1) + ' ' +
            yAt(segs[s][t].v, lo, hi).toFixed(1);
        }
      }
      var path = proto.cloneNode(false);
      path.setAttribute('class', 'bl b' + data.benches[b].slot);
      path.setAttribute('d', dStr);
      host.appendChild(path);
    }

    /* 目盛り 3 本と、その値。 */
    var gridHost = $('grid'), gproto = gridHost.querySelector('.proto');
    while (gridHost.lastChild !== gproto) { gridHost.removeChild(gridHost.lastChild); }
    var labels = $('yLabels');
    clear(labels);
    var stops = [PAD_Y, VB_H / 2, VB_H - PAD_Y];
    for (var g = 0; g < stops.length; g++) {
      var ln = gproto.cloneNode(false);
      ln.setAttribute('class', 'gl');
      ln.setAttribute('y1', String(stops[g]));
      ln.setAttribute('y2', String(stops[g]));
      gridHost.appendChild(ln);
      var value = lo + (VB_H - PAD_Y - stops[g]) / (VB_H - 2 * PAD_Y) * (hi - lo);
      var lab = el('span', 'y-label', data.unit === 'yen' ? man(value) : value.toFixed(1));
      lab.style.top = (stops[g] / VB_H * 100) + '%';
      labels.appendChild(lab);
    }

    $('xFirst').textContent = data.dates[0];
    $('xLast').textContent = data.dates[data.dates.length - 1];
    $('xUnit').textContent = data.unit === 'yen'
      ? '総資産'
      : (data.compare ? '起点 = 100' : '初期資産 = 100');

    updateLegendValues(data);
    renderChartNotes(data);
  }

  function periodReturn(vals) {
    var first = null, last = null;
    for (var i = 0; i < vals.length; i++) { if (num(vals[i])) { if (first === null) { first = vals[i]; } last = vals[i]; } }
    if (first === null || last === null || first === 0) { return null; }
    return (last / first - 1) * 100;
  }

  function buildLegend() {
    var host = $('legend');
    clear(host);
    if (!chartState.compare) { show(host, false); return; }
    show(host, true);

    var accLi = el('li', 'legend-item');
    var accSw = el('span', 'swatch acc');
    accSw.setAttribute('aria-hidden', 'true');
    accLi.appendChild(accSw);
    accLi.appendChild(el('span', 'legend-name', '口座'));
    accLi.appendChild(el('span', 'legend-val', ''));
    host.appendChild(accLi);

    for (var i = 0; i < chartState.benches.length; i++) {
      (function (bench, slot) {
        var li = el('li');
        var btn = el('button', 'legend-item legend-btn');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(!!chartState.visible[bench.key]));
        var sw = el('span', 'swatch s' + slot);
        sw.setAttribute('aria-hidden', 'true');
        btn.appendChild(sw);
        /* label は組み立てず、そのまま出す（円換算できなかったときは label 側が変わる）。 */
        btn.appendChild(el('span', 'legend-name', bench.label || bench.key));
        btn.appendChild(el('span', 'legend-val', ''));
        btn.appendChild(el('span', 'legend-gap', ''));
        btn.addEventListener('click', function () {
          chartState.visible[bench.key] = !chartState.visible[bench.key];
          btn.setAttribute('aria-pressed', String(chartState.visible[bench.key]));
          drawChart();
        });
        li.appendChild(btn);
        host.appendChild(li);
      })(chartState.benches[i], i % 4);
    }
  }

  function updateLegendValues(data) {
    var host = $('legend');
    if (!chartState || !chartState.compare) { return; }
    var items = host.querySelectorAll('.legend-item');
    if (!items.length) { return; }

    var accRet = data ? periodReturn(data.account) : null;
    var accVal = items[0].querySelector('.legend-val');
    accVal.textContent = accRet === null ? '—' : pctText(accRet);
    accVal.className = 'legend-val ' + (accRet === null ? '' : toneOf(accRet));

    for (var i = 0; i < chartState.benches.length; i++) {
      var item = items[i + 1];
      if (!item) { continue; }
      var key = chartState.benches[i].key;
      var line = null;
      if (data) {
        for (var j = 0; j < data.benches.length; j++) { if (data.benches[j].bench.key === key) { line = data.benches[j]; } }
      }
      var ret = line ? periodReturn(line.vals) : null;
      var valEl = item.querySelector('.legend-val');
      var gapEl = item.querySelector('.legend-gap');
      valEl.textContent = ret === null ? '' : pctText(ret);
      valEl.className = 'legend-val ' + (ret === null ? '' : toneOf(ret));
      gapEl.textContent = (ret === null || accRet === null) ? '' : '差 ' + ptText(accRet - ret);
    }
  }

  /* グラフの読み方に必要な注記。装飾ではないので、条件を満たす限り必ず出す。 */
  function renderChartNotes(data) {
    var host = $('chartNotes');
    clear(host);
    if (!chartState) { return; }
    var lines = [];

    if (num(chartState.invested)) {
      lines.push('株式組入比率 ' + chartState.invested.toFixed(1) + '%。口座は現金を持っていますが、指数はフルインベストです。');
    }
    if (chartState.compare) {
      lines.push('指数は配当を含みません。');

      var vis = visibleBenches(), filled = {}, fxNotes = [];
      var fromDate = data && data.dates.length ? data.dates[0] : null;
      var toDate = data && data.dates.length ? data.dates[data.dates.length - 1] : null;
      for (var i = 0; i < vis.length; i++) {
        var b = vis[i].bench;
        var fd = Array.isArray(b.filled_dates) ? b.filled_dates : [];
        for (var j = 0; j < fd.length; j++) {
          if (fromDate && (fd[j] < fromDate || fd[j] > toDate)) { continue; }
          filled[fd[j]] = 1;
        }
        if (b.fx_adjusted === true) {
          if (num(b.fx_rate_last) && b.fx_rate_last_date) {
            fxNotes.push((b.label || b.key) + ' は 1 ドル = ' + b.fx_rate_last.toFixed(2) + ' 円（' +
              b.fx_rate_last_date + ' 時点）を含む日次レートで円換算しています。');
          } else {
            fxNotes.push((b.label || b.key) + ' は日次の為替レートで円換算しています。');
          }
        }
      }
      var count = 0;
      for (var k in filled) { if (Object.prototype.hasOwnProperty.call(filled, k)) { count++; } }
      if (count > 0) { lines.push('休場日 ' + count + ' 日は直前の終値で補完しています。'); }
      for (var f = 0; f < fxNotes.length; f++) { lines.push(fxNotes[f]); }
    }

    for (var n = 0; n < lines.length; n++) { host.appendChild(el('p', 'chart-note', lines[n])); }
  }

  $('ranges').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.seg-opt') : null;
    if (!btn || !chartState) { return; }
    chartState.range = btn.getAttribute('data-range');
    var btns = $('ranges').querySelectorAll('.seg-opt');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i] === btn));
    }
    drawChart();
  });

  /* ---------- 起動 ---------- */

  function render(d) {
    var now = Date.now();
    var gen = d.generated_at ? ms(d.generated_at) : null;
    var st = renderHead(d, now);
    renderBanners(d, st, gen);
    renderSummary(d);
    prepareChart(d);
    renderPositions(d);
    renderTrades(d);
    show($('main'), true);
  }

  function fail(message) {
    $('fatalBody').textContent = message;
    show($('fatal'), true);
    show($('main'), false);
    $('genAt').textContent = '—';
    $('freshDot').className = 'dot is-unknown';
  }

  function dataPath() {
    /* 既定は data/portfolio.json。?data=… は検証用サンプルを開くためだけの相対パス指定。 */
    var m = window.location.search.match(/[?&]data=([A-Za-z0-9._-]+)/);
    return m ? 'data/' + m[1] : 'data/portfolio.json';
  }

  /* 本番（GitHub Pages）はキャッシュ回避のクエリ付きで 1 回だけ取得する。
     クエリ付きを拒否する配信環境で試せるよう、失敗したときだけクエリ無しで 1 度やり直す。 */
  function load(path) {
    return fetch(path + '?t=' + Date.now())
      .then(function (res) { return res.ok ? res : fetch(path); })
      .then(function (res) {
        if (!res.ok) { throw new Error(path + ' を取得できませんでした（HTTP ' + res.status + '）。'); }
        return res.json();
      });
  }

  load(dataPath())
    .then(function (d) { render(d); })
    .catch(function (err) {
      fail((err && err.message ? err.message : String(err)) + ' 時間をおいて再読み込みしてください。');
    });
})();
