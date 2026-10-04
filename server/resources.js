const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  const affectedBatchIds = {};
  records.forEach((r) => { affectedBatchIds[r.batchId] = true; });
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    affectedBatchCount: Object.keys(affectedBatchIds).length,
    participates: coldlib.probeParticipates(probe),
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  const room = coldlib.roomOf(data, batch.roomId);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    roomStatus: room ? room.status : '',
    roomRunning: !!room && room.status === '运行',
    totalRecordCount: check.totalRecordCount,
    excludedRecordCount: check.excludedRecordCount,
    excludedProbes: check.excludedProbes,
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

// 一条温度记录在当前判定口径下是否参与判定
function recordJudgement(data, row) {
  const probe = coldlib.probeOf(data, row.probeId);
  if (coldlib.probeParticipates(probe)) return { participates: true, excludedReason: '' };
  return {
    participates: false,
    probeStatus: probe ? probe.status : '已删除',
    excludedReason: probe ? '探头「' + probe.code + '」状态为「' + probe.status + '」，不参与判定' : '探头已不在台账，不参与判定',
  };
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

// 冷库状态变更不影响放行判定本身（检修/停用中的批次照常记录与判定），
// 但概览与统计里「在办、可放行、被挡下」要按冷库状态分出运行口径，这里给出前后对照
function roomImpact(data, roomId, statusBefore) {
  const room = data.rooms.find((r) => r.id === roomId);
  const batches = data.batches.filter((b) => b.roomId === roomId);
  const open = batches.filter((b) => b.status === '在库' || b.status === '待放行');
  const decorated = open.map((b) => ({ batch: b, check: coldlib.releaseCheck(data, b) }));
  // 这些批次都属于本库，是否计入「仅运行库」口径只取决于本库当时状态
  const ownScope = {
    openBatchCount: decorated.length,
    readyToRelease: decorated.filter((d) => d.check.pass).length,
    blockedCount: decorated.filter((d) => !d.check.pass).length,
  };
  const zeroScope = { openBatchCount: 0, readyToRelease: 0, blockedCount: 0 };
  return {
    statusBefore,
    statusAfter: room.status,
    batchCount: batches.length,
    batches: batches.map((b) => ({ batchId: b.id, batchCode: b.code, product: b.product, batchStatus: b.status, roomStatus: room.status })),
    runningScopeBefore: statusBefore === '运行' ? ownScope : zeroScope,
    runningScopeAfter: room.status === '运行' ? ownScope : zeroScope,
    ownScope,
  };
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const statusBefore = room.status;
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  const impact = statusBefore !== room.status ? roomImpact(data, id, statusBefore) : null;
  return { room: decorateRoom(data, room), impact };
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

// 探头变更前后，把它名下记录涉及的批次判定各算一遍，给出对照
function probeImpact(data, probeId, beforeChecks) {
  const batchIds = {};
  data.records.filter((r) => r.probeId === probeId).forEach((r) => { batchIds[r.batchId] = true; });
  const items = Object.keys(batchIds).map((bid) => {
    const batch = data.batches.find((b) => b.id === bid);
    if (!batch) return null;
    const after = coldlib.releaseCheck(data, batch);
    const before = beforeChecks[bid] || after;
    const diff = coldlib.compareCheck(before, after);
    return {
      batchId: batch.id,
      batchCode: batch.code,
      product: batch.product,
      batchStatus: batch.status,
      open: batch.status === '在库' || batch.status === '待放行',
      beforePass: before.pass,
      afterPass: after.pass,
      before: diff.before,
      after: diff.after,
      changed: diff.changed,
      conclusionChanged: diff.conclusionChanged,
      flipped: diff.flipped,
    };
  }).filter(Boolean);
  return {
    affectedCount: items.length,
    changedCount: items.filter((i) => i.changed).length,
    conclusionChangedCount: items.filter((i) => i.conclusionChanged).length,
    items: items.sort((a, b) => (a.conclusionChanged === b.conclusionChanged ? 0 : a.conclusionChanged ? -1 : 1)),
  };
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const affectedBatchIds = {};
  data.records.filter((r) => r.probeId === id).forEach((r) => { affectedBatchIds[r.batchId] = true; });
  const beforeChecks = {};
  Object.keys(affectedBatchIds).forEach((bid) => {
    const batch = data.batches.find((b) => b.id === bid);
    if (batch) beforeChecks[bid] = coldlib.releaseCheck(data, batch);
  });
  const statusBefore = probe.status;
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  const impact = probeImpact(data, id, beforeChecks);
  impact.statusBefore = statusBefore;
  impact.statusAfter = probe.status;
  impact.participatesBefore = statusBefore === '在用';
  impact.participatesAfter = probe.status === '在用';
  return { probe: decorateProbe(data, probe), impact };
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.roomStatus) rows = rows.filter((b) => {
    const room = coldlib.roomOf(data, b.roomId);
    return room && room.status === q.roomStatus;
  });
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const currentCheck = coldlib.releaseCheck(data, batch);
  const rows = coldlib.recordsOfBatch(data, id).map((r) => {
    const judge = recordJudgement(data, r);
    return Object.assign({}, r, {
      probeCode: probeCode(data, r.probeId),
      probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
      participates: judge.participates,
      excludedReason: judge.excludedReason,
    });
  });
  const releases = data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1))
    .map((r) => decorateRelease(data, r, currentCheck));
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    excludedRecords: coldlib.excludedRecords(data, id),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    releases,
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => {
      const judge = recordJudgement(data, r);
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        probeCode: probeCode(data, r.probeId),
        outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
        participates: judge.participates,
        excludedReason: judge.excludedReason,
      });
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  else if (!coldlib.probeParticipates(probe)) errors.probeId = '探头状态为「' + probe.status + '」，不能登记新记录；历史记录仍保留可查';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

// 老放行单没有 checkSnapshot，用存档字段拼一个对照基线
function legacySnapshot(release) {
  return {
    pass: release.decision === '放行',
    mkt: release.mkt,
    longestMinutes: release.longestExcursionMinutes,
    totalMinutes: release.totalExcursionMinutes,
    recordCount: null,
    chainGapCount: release.chainGapCount,
    excludedProbes: [],
    expiredProbeCodes: [],
    failed: release.decision === '放行' ? [] : ['(存档前未记录明细)'],
    legacy: true,
  };
}

// 放行台账/批次详情：放行单带当时判定存档，并与当前口径对照（历史结论不会被改写）
function decorateRelease(data, release, currentCheckMaybe) {
  const batch = data.batches.find((b) => b.id === release.batchId);
  const current = currentCheckMaybe || (batch ? coldlib.releaseCheck(data, batch) : null);
  const snapshot = release.checkSnapshot || legacySnapshot(release);
  let drift = null;
  if (current) {
    drift = {
      currentPass: current.pass,
      conclusionChanged: snapshot.pass !== current.pass,
      mkt: current.mkt,
      longestMinutes: current.longestMinutes,
      totalMinutes: current.totalMinutes,
      recordCount: current.recordCount,
      chainGapCount: current.chain.gapCount,
      excludedProbes: current.excludedProbes,
      failed: current.failed,
    };
  }
  return Object.assign({}, release, {
    batchCode: batchCode(data, release.batchId),
    roomStatus: batch ? (coldlib.roomOf(data, batch.roomId) || {}).status || '' : '',
    checkSnapshot: snapshot,
    current: drift,
  });
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => decorateRelease(data, r))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

const CONDITION_TEXT = {
  records: '至少有一条参与判定的温度记录',
  longest: '单次连续超限不超限',
  total: '累计超限不超限',
  chain: '全程没有断链',
  calibration: '参与判定的探头都在校准有效期内',
};

// 放行：登记放行单并改批次状态；判定不过的批次不能放行。
// 放行单存当时完整判定快照，之后状态/口径变化不会改写历史结论
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  if (payload.decision === '放行' && !check.pass) {
    const names = check.failed.map((k) => CONDITION_TEXT[k] || k);
    throw new AppError(409, 'RELEASE_CHECK_FAILED', '这个批次当前不满足放行条件，不能放行：' + names.join('；'), { failed: check.failed, batchCode: batch.code });
  }
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
    checkSnapshot: check,
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release: decorateRelease(data, release, check), batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
