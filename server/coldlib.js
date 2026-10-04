// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function roomOf(data, roomId) {
  return data.rooms.find((r) => r.id === roomId) || null;
}

// 探头是否处于可参与判定的状态：只有「在用」参与；停用、送检都不参与
function probeParticipates(probe) {
  return !!probe && probe.status === '在用';
}

// 一个批次名下被排除在判定之外的记录（台账仍保留、可查）
// 原因：探头停用/送检，或探头已不在台账上
function excludedRecords(data, batchId) {
  return recordsOfBatch(data, batchId).map((row) => {
    const probe = probeOf(data, row.probeId);
    if (probeParticipates(probe)) return null;
    return {
      id: row.id,
      probeId: row.probeId,
      probeCode: probe ? probe.code : '',
      probeStatus: probe ? probe.status : '已删除',
      reason: probe ? '探头状态为「' + probe.status + '」，名下记录不参与判定' : '探头已不在台账，记录不参与判定',
    };
  }).filter(Boolean);
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准；
// 停用/送检探头名下的记录一律不进判定（记录本身仍在 records 里可查）
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId).filter((row) => probeParticipates(probeOf(data, row.probeId)));
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    // 后到的手工更正记录覆盖自动记录
    if (row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 被排除探头的汇总：判定条目里要写明因为哪台探头剔掉了几条记录
function excludedProbeSummary(data, batchId) {
  const map = {};
  const order = [];
  for (const row of recordsOfBatch(data, batchId)) {
    const probe = probeOf(data, row.probeId);
    if (probeParticipates(probe)) continue;
    if (!map[row.probeId]) {
      map[row.probeId] = {
        probeId: row.probeId,
        probeCode: probe ? probe.code : '',
        probeStatus: probe ? probe.status : '已删除',
        reason: probe ? '探头「' + probe.code + '」状态为「' + probe.status + '」' : '探头已不在台账',
        count: 0,
        firstAt: row.at,
        lastAt: row.at,
      };
      order.push(row.probeId);
    }
    const item = map[row.probeId];
    item.count += 1;
    if (row.at < item.firstAt) item.firstAt = row.at;
    if (row.at > item.lastAt) item.lastAt = row.at;
  }
  return order.map((id) => map[id]);
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：有记录、最长超限、累计超限、断链、探头校准五条；
// 停用/送检探头名下记录已在 effectiveRecords 阶段剔除，并在 excludedProbes 里点名
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const excluded = excludedProbeSummary(data, batch.id);
  const room = roomOf(data, batch.roomId);
  const conditions = [
    { key: 'records', ok: stats.recordCount > 0, value: stats.recordCount, limit: 1, text: '至少有一条参与判定的温度记录（没有任何温度记录的批次不能放行）' },
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    totalRecordCount: recordsOfBatch(data, batch.id).length,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    excludedProbes: excluded,
    excludedRecordCount: excluded.reduce((acc, p) => acc + p.count, 0),
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
    roomId: batch.roomId,
    roomCode: room ? room.code : '',
    roomStatus: room ? room.status : '',
    roomRunning: !!room && room.status === '运行',
  };
}

// 判定快照里用于前后对照的关键字段
function checkSignature(check) {
  return {
    pass: !!check.pass,
    failed: (check.failed || []).slice(),
    mkt: check.mkt,
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    recordCount: check.recordCount,
    chainGapCount: check.chain ? check.chain.gapCount : 0,
    expiredProbeCodes: (check.expiredProbes || []).map((p) => p.probeCode),
    excludedProbes: (check.excludedProbes || []).map((p) => p.probeCode + '×' + p.count),
  };
}

// 同一批次前后两次判定的对照（结论是否变化、哪几条翻转）
function compareCheck(before, after) {
  const a = checkSignature(before);
  const b = checkSignature(after);
  const changed = a.pass !== b.pass
    || JSON.stringify(a.failed) !== JSON.stringify(b.failed)
    || a.mkt !== b.mkt
    || a.longestMinutes !== b.longestMinutes
    || a.totalMinutes !== b.totalMinutes
    || a.recordCount !== b.recordCount
    || a.chainGapCount !== b.chainGapCount
    || JSON.stringify(a.expiredProbeCodes) !== JSON.stringify(b.expiredProbeCodes)
    || JSON.stringify(a.excludedProbes) !== JSON.stringify(b.excludedProbes);
  const failedSet = new Set(a.failed.concat(b.failed));
  const flipped = [];
  failedSet.forEach((key) => {
    const wasFailing = a.failed.includes(key);
    const nowFailing = b.failed.includes(key);
    if (wasFailing !== nowFailing) flipped.push({ key, wasFailing, nowFailing });
  });
  return { changed, conclusionChanged: a.pass !== b.pass, flipped, before: a, after: b };
}

module.exports = {
  toDate,
  probeOf,
  roomOf,
  probeParticipates,
  recordsOfBatch,
  excludedRecords,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  excludedProbeSummary,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
  checkSignature,
  compareCheck,
};
