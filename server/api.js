const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const res = require('./resources');
const coldlib = require('./coldlib');

const router = express.Router();

function withData(handler) {
  return (req, reqRes, next) => {
    try {
      const data = store.load();
      const result = handler(data, req);
      if (result && result.__save === true) store.save(data);
      if (result && typeof result === 'object' && '__body' in result) reqRes.json(result.__body);
      else reqRes.json(result);
    } catch (err) {
      next(err);
    }
  };
}

function overview(data) {
  const settings = data.settings;
  const roomById = {};
  data.rooms.forEach((r) => { roomById[r.id] = r; });
  const decorated = data.batches.map((b) => {
    const detail = coldlib.releaseCheck(data, b);
    return { batch: b, check: detail, room: roomById[b.roomId] || null };
  });
  const statusCount = {};
  for (const b of data.batches) statusCount[b.status] = (statusCount[b.status] || 0) + 1;
  const isOpen = (b) => b.status === '在库' || b.status === '待放行';
  const openAll = decorated.filter((d) => isOpen(d.batch));

  // 统计分口径：全部冷库 / 仅运行中冷库 / 检修与停用冷库。
  // 检修与停用冷库的批次照常判定，但在运行口径里单独分出来，不混进在办与放行盘子
  function scopeRows(rows, kind) {
    if (kind === 'running') return rows.filter((d) => d.room && d.room.status === '运行');
    if (kind === 'nonRunning') return rows.filter((d) => d.room && d.room.status !== '运行');
    return rows;
  }
  function summarize(kind) {
    const open = scopeRows(openAll, kind);
    const pool = scopeRows(decorated, kind);
    const mktValues = pool.map((d) => d.check.mkt).filter((v) => v > 0);
    const noRecordBatches = pool.filter((d) => d.check.totalRecordCount === 0).length;
    return {
      openBatchCount: open.length,
      readyToRelease: open.filter((d) => d.check.pass).length,
      blockedCount: open.filter((d) => !d.check.pass).length,
      noRecordBatches,
      maxMkt: mktValues.length ? store.round(Math.max.apply(null, mktValues)) : 0,
      averageMkt: mktValues.length ? store.round(mktValues.reduce((a, b) => a + b, 0) / mktValues.length) : 0,
    };
  }
  const allScope = summarize('all');
  const runningScope = summarize('running');
  const nonRunningScope = summarize('nonRunning');

  const openByRoomStatus = { 运行: 0, 检修: 0, 停用: 0 };
  openAll.forEach((d) => {
    const key = d.room ? d.room.status : '';
    if (key in openByRoomStatus) openByRoomStatus[key] += 1;
  });
  const expiredProbes = data.probes.filter((p) => !coldlib.probeValidOn(p, store.nowText().slice(0, 10))).length;
  return {
    today: store.nowText().slice(0, 10),
    roomCount: data.rooms.length,
    runningRoomCount: data.rooms.filter((r) => r.status === '运行').length,
    maintenanceRoomCount: data.rooms.filter((r) => r.status === '检修').length,
    stoppedRoomCount: data.rooms.filter((r) => r.status === '停用').length,
    probeCount: data.probes.length,
    runningProbeCount: data.probes.filter((p) => p.status === '在用').length,
    stoppedProbeCount: data.probes.filter((p) => p.status !== '在用').length,
    expiredProbeCount: expiredProbes,
    batchCount: data.batches.length,
    statusCount,
    openBatchCount: allScope.openBatchCount,
    openByRoomStatus,
    recordCount: data.records.length,
    manualRecordCount: data.records.filter((r) => r.source === '人工').length,
    excludedRecordCount: data.records.filter((r) => {
      const probe = coldlib.probeOf(data, r.probeId);
      return !coldlib.probeParticipates(probe);
    }).length,
    releaseCount: data.releases.length,
    releasedCount: data.releases.filter((r) => r.decision === '放行').length,
    rejectedCount: data.releases.filter((r) => r.decision === '拒收').length,
    readyToRelease: allScope.readyToRelease,
    blockedCount: allScope.blockedCount,
    noRecordBatches: allScope.noRecordBatches,
    maxMkt: allScope.maxMkt,
    averageMkt: allScope.averageMkt,
    scope: { all: allScope, running: runningScope, nonRunning: nonRunningScope },
    settings: {
      lowerLimitC: Number(settings.lowerLimitC),
      upperLimitC: Number(settings.upperLimitC),
      allowExcursionMinutes: Number(settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(settings.allowTotalExcursionMinutes),
      chainGapMinutes: Number(settings.chainGapMinutes),
      recordIntervalMinutes: Number(settings.recordIntervalMinutes),
    },
    rooms: data.rooms.map((r) => {
      const probes = data.probes.filter((p) => p.roomId === r.id);
      const batches = data.batches.filter((b) => b.roomId === r.id);
      const openBatches = batches.filter(isOpen);
      const openChecks = openBatches.map((b) => coldlib.releaseCheck(data, b));
      return {
        id: r.id, code: r.code, name: r.name, type: r.type, status: r.status,
        probeCount: probes.length,
        runningProbeCount: probes.filter((p) => p.status === '在用').length,
        batchCount: batches.length,
        openBatchCount: openBatches.length,
        readyToRelease: openChecks.filter((c) => c.pass).length,
        blockedCount: openChecks.filter((c) => !c.pass).length,
      };
    }),
  };
}

router.get('/health', (req, r) => r.json({ ok: true, service: '冷链温控与批次放行台', time: new Date().toISOString() }));
router.get('/summary', withData((data) => overview(data)));
router.get('/settings', withData((data) => data.settings));
router.patch('/settings', withData((data, req) => {
  const patch = req.body || {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) if (patch[key] !== undefined) data.settings[key] = patch[key];
  return { __save: true, __body: data.settings };
}));

router.get('/rooms', withData((data, req) => res.listRooms(data, req.query)));
router.post('/rooms', withData((data, req) => ({ __save: true, __body: res.createRoom(data, req.body || {}) })));
router.get('/rooms/:id', withData((data, req) => res.roomDetail(data, req.params.id)));
router.patch('/rooms/:id', withData((data, req) => ({ __save: true, __body: res.updateRoom(data, req.params.id, req.body || {}) })));
router.delete('/rooms/:id', withData((data, req) => ({ __save: true, __body: res.removeRoom(data, req.params.id) })));

router.get('/probes', withData((data, req) => res.listProbes(data, req.query)));
router.post('/probes', withData((data, req) => ({ __save: true, __body: res.createProbe(data, req.body || {}) })));
router.patch('/probes/:id', withData((data, req) => ({ __save: true, __body: res.updateProbe(data, req.params.id, req.body || {}) })));
router.delete('/probes/:id', withData((data, req) => ({ __save: true, __body: res.removeProbe(data, req.params.id) })));

router.get('/batches', withData((data, req) => res.listBatches(data, req.query)));
router.post('/batches', withData((data, req) => ({ __save: true, __body: res.createBatch(data, req.body || {}) })));
router.get('/batches/:id', withData((data, req) => res.batchDetail(data, req.params.id)));
router.patch('/batches/:id', withData((data, req) => ({ __save: true, __body: res.updateBatch(data, req.params.id, req.body || {}) })));
router.delete('/batches/:id', withData((data, req) => ({ __save: true, __body: res.removeBatch(data, req.params.id) })));
router.get('/batches/:id/release-check', withData((data, req) => {
  const batch = data.batches.find((b) => b.id === req.params.id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  return coldlib.releaseCheck(data, batch);
}));
router.post('/batches/:id/decision', withData((data, req) => ({ __save: true, __body: res.decide(data, req.params.id, req.body || {}) })));

router.get('/records', withData((data, req) => res.listRecords(data, req.query)));
router.post('/records', withData((data, req) => ({ __save: true, __body: res.createRecord(data, req.body || {}) })));
router.delete('/records/:id', withData((data, req) => ({ __save: true, __body: res.removeRecord(data, req.params.id) })));

router.get('/releases', withData((data, req) => res.listReleases(data, req.query)));

router.use((req, r, next) => next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl)));

module.exports = router;
