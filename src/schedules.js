const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

const router = express.Router();
router.use(authRequired);

function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

function getScheduleOfRehearsalOrThrow(scheduleId, rehearsalId) {
  const s = db
    .prepare(
      `SELECT s.*, sc.code AS scene_code, sc.title AS scene_title
         FROM rehearsal_schedules s JOIN scenes sc ON sc.id = s.scene_id
        WHERE s.id = ? AND s.rehearsal_id = ?`
    )
    .get(scheduleId, rehearsalId);
  if (!s) throw notFound('日程安排不存在');
  return s;
}

// ---- 带时区时间解析 ----
const ISO_HEAD = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?/;
const TZ_TAIL = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 解析“带时区”的起止时间。必须显式携带时区（Z 或 ±HH:MM），
 * 返回原始字符串与 epoch 毫秒（重叠比较统一用毫秒，端点相接不算重叠）。
 */
function parseTimePoint(value, field) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw badRequest(`${field} 必填：带时区的 ISO 8601 时间（如 2026-10-03T19:00:00+08:00）`);
  if (!ISO_HEAD.test(s) || !TZ_TAIL.test(s)) {
    throw badRequest(`${field} 必须带时区（Z 或 ±HH:MM），如 2026-10-03T19:00:00+08:00`);
  }
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) throw badRequest(`${field} 不是合法时间`);
  return { raw: s, ts };
}

// ---- 参与者 / 待补派（均按排练当前固定版本动态计算） ----
function sceneHasLines(versionId, sceneId) {
  return !!db
    .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? LIMIT 1')
    .get(versionId, sceneId);
}

/** 某时段的参与者（演员 × 角色）：该版本本场次有台词且已派角 */
function slotParticipantRoles(rehearsalId, versionId, sceneId) {
  return db
    .prepare(
      `SELECT DISTINCT c.actor_id AS actorId, u.display_name AS actorName,
              ro.id AS roleId, ro.code AS roleCode, ro.name AS roleName
         FROM version_lines vl
         JOIN rehearsal_cast c ON c.rehearsal_id = ? AND c.role_id = vl.role_id
         JOIN roles ro ON ro.id = vl.role_id
         JOIN users u ON u.id = c.actor_id
        WHERE vl.version_id = ? AND vl.scene_id = ?
        ORDER BY ro.id`
    )
    .all(rehearsalId, versionId, sceneId);
}

/** 待补派：该版本本场次有台词但尚未派角的角色（不阻止安排） */
function slotUncastRoles(rehearsalId, versionId, sceneId) {
  return db
    .prepare(
      `SELECT DISTINCT ro.id AS roleId, ro.code AS roleCode, ro.name AS roleName
         FROM version_lines vl
         JOIN roles ro ON ro.id = vl.role_id
        WHERE vl.version_id = ? AND vl.scene_id = ?
          AND vl.role_id NOT IN (SELECT role_id FROM rehearsal_cast WHERE rehearsal_id = ?)
        ORDER BY ro.id`
    )
    .all(versionId, sceneId, rehearsalId);
}

// ---- 冲突检测 ----
/**
 * 汇总全库未取消时段的“演员 × 时段”参与情况。
 * versionOverride: Map<rehearsalId, versionId>，用于换版前按目标版本预演参与者；
 * 待调整时段（场次在该版本无台词）自然没有参与者，因而不计入冲突。
 */
function collectParticipations(versionOverride = new Map()) {
  const slots = db
    .prepare(
      `SELECT s.*, r.version_id, r.name AS rehearsal_name,
              sc.code AS scene_code, sc.title AS scene_title
         FROM rehearsal_schedules s
         JOIN rehearsals r ON r.id = s.rehearsal_id
         JOIN scenes sc ON sc.id = s.scene_id
        WHERE s.status = 'active'
        ORDER BY s.start_ts, s.id`
    )
    .all();
  const byActor = new Map(); // actorId -> { actorName, slots: [] }
  for (const slot of slots) {
    const vid = versionOverride.get(slot.rehearsal_id) ?? slot.version_id;
    const parts = db
      .prepare(
        `SELECT DISTINCT c.actor_id AS actorId, u.display_name AS actorName
           FROM version_lines vl
           JOIN rehearsal_cast c ON c.rehearsal_id = ? AND c.role_id = vl.role_id
           JOIN users u ON u.id = c.actor_id
          WHERE vl.version_id = ? AND vl.scene_id = ?`
      )
      .all(slot.rehearsal_id, vid, slot.scene_id);
    for (const p of parts) {
      if (!byActor.has(p.actorId)) byActor.set(p.actorId, { actorName: p.actorName, slots: [] });
      byActor.get(p.actorId).slots.push(slot);
    }
  }
  return byActor;
}

function slotRef(s) {
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    rehearsalName: s.rehearsal_name,
    sceneId: s.scene_id,
    sceneCode: s.scene_code,
    sceneTitle: s.scene_title,
    startAt: s.start_at,
    endAt: s.end_at,
  };
}

/** 端点相接不算重叠：严格不等式 */
const overlaps = (a, b) => a.start_ts < b.end_ts && b.start_ts < a.end_ts;

/**
 * 找出所有“同一演员参与且时间重叠”的未取消时段。
 * 返回 [{ actorId, actorName, slots: [slotRef, ...] }]，按演员分组给出其冲突时段。
 */
function findScheduleConflicts(versionOverride = new Map()) {
  const byActor = collectParticipations(versionOverride);
  const conflicts = [];
  for (const [actorId, { actorName, slots }] of byActor) {
    const involved = new Map();
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        if (slots[i].id !== slots[j].id && overlaps(slots[i], slots[j])) {
          involved.set(slots[i].id, slots[i]);
          involved.set(slots[j].id, slots[j]);
        }
      }
    }
    if (involved.size > 0) {
      conflicts.push({
        actorId,
        actorName,
        slots: [...involved.values()].map(slotRef),
      });
    }
  }
  return conflicts;
}

/**
 * 业务操作前置校验：若参与演员与其他未取消时段重叠，抛 409 SCHEDULE_CONFLICT，
 * 由外层事务回滚保证“整次操作不生效”。
 * 过滤口径：
 *   scheduleId     —— 保存/调整时段：只看涉及本时段的冲突
 *   actorId        —— 派角/改派：只看该演员的冲突
 *   rehearsalId+versionOverride —— 换版：按目标版本预演，只看涉及本排练时段的冲突
 */
function assertNoScheduleConflicts({ scheduleId = null, actorId = null, rehearsalId = null, versionOverride = null } = {}) {
  const overrides = new Map();
  if (rehearsalId != null && versionOverride != null) overrides.set(rehearsalId, versionOverride);
  let conflicts = findScheduleConflicts(overrides);
  if (scheduleId != null) {
    conflicts = conflicts.filter((c) => c.slots.some((s) => s.id === scheduleId));
  } else if (actorId != null) {
    conflicts = conflicts.filter((c) => c.actorId === actorId);
  } else if (rehearsalId != null) {
    conflicts = conflicts.filter((c) => c.slots.some((s) => s.rehearsalId === rehearsalId));
  }
  if (conflicts.length > 0) {
    throw conflict(
      'SCHEDULE_CONFLICT',
      '参与演员与其他未取消时段重叠，本次操作未生效',
      { conflicts }
    );
  }
}

// ---- 序列化 ----
function listSchedules(rehearsalId) {
  return db
    .prepare(
      `SELECT s.*, sc.code AS scene_code, sc.title AS scene_title
         FROM rehearsal_schedules s JOIN scenes sc ON sc.id = s.scene_id
        WHERE s.rehearsal_id = ?
        ORDER BY s.start_ts, s.id`
    )
    .all(rehearsalId);
}

/** 导演视角：含参与者、待补派、待调整、取消状态 */
function serializeSchedule(row, rehearsal) {
  const active = row.status === 'active';
  const hasLines = sceneHasLines(rehearsal.version_id, row.scene_id);
  return {
    id: row.id,
    rehearsalId: row.rehearsal_id,
    sceneId: row.scene_id,
    sceneCode: row.scene_code,
    sceneTitle: row.scene_title,
    startAt: row.start_at,
    endAt: row.end_at,
    note: row.note,
    status: row.status,
    needsAdjustment: active && !hasLines,
    participants: active ? slotParticipantRoles(rehearsal.id, rehearsal.version_id, row.scene_id) : [],
    uncastRoles: active ? slotUncastRoles(rehearsal.id, rehearsal.version_id, row.scene_id) : [],
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

/** 演员视角：仅自己当前参与的有效时段，且只暴露自己的角色 */
function actorScheduleView(row, rehearsal, myParts) {
  return {
    id: row.id,
    rehearsalId: row.rehearsal_id,
    rehearsalName: rehearsal.name,
    playId: rehearsal.play_id,
    sceneId: row.scene_id,
    sceneCode: row.scene_code,
    sceneTitle: row.scene_title,
    startAt: row.start_at,
    endAt: row.end_at,
    note: row.note,
    myRoles: myParts.map((p) => ({ roleId: p.roleId, roleCode: p.roleCode, roleName: p.roleName })),
  };
}

/** 演员在某排练中当前参与的有效时段 */
function actorSchedules(rehearsal, actorId) {
  const mine = [];
  for (const row of listSchedules(rehearsal.id)) {
    if (row.status !== 'active') continue;
    const parts = slotParticipantRoles(rehearsal.id, rehearsal.version_id, row.scene_id).filter(
      (p) => p.actorId === actorId
    );
    if (parts.length > 0) mine.push(actorScheduleView(row, rehearsal, parts));
  }
  return mine;
}

/** 导演视角的日程列表 + 待补派/待调整/已取消汇总 */
function directorSchedules(rehearsal) {
  const schedules = listSchedules(rehearsal.id).map((row) => serializeSchedule(row, rehearsal));
  return {
    schedules,
    summary: {
      pendingCast: schedules.filter((s) => s.status === 'active' && s.uncastRoles.length > 0).length,
      needsAdjustment: schedules.filter((s) => s.needsAdjustment).length,
      cancelled: schedules.filter((s) => s.status === 'cancelled').length,
    },
  };
}

// ---- 路由 ----
// 安排时段（导演）：场次须属于该剧且在当前版本有台词；结束须晚于开始；时间必须带时区
router.post(
  '/rehearsals/:id/schedules',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const sceneId = Number(req.body?.sceneId);
    if (!Number.isInteger(sceneId)) throw badRequest('sceneId 必填');
    const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND play_id = ?').get(sceneId, r.play_id);
    if (!scene) throw badRequest('场次不存在或不属于该剧');
    if (!sceneHasLines(r.version_id, sceneId)) {
      throw badRequest('该场次在排练当前固定版本中没有台词，不能安排时段');
    }
    const start = parseTimePoint(req.body?.startAt, 'startAt');
    const end = parseTimePoint(req.body?.endAt, 'endAt');
    if (end.ts <= start.ts) throw badRequest('结束时间必须晚于开始时间');
    const note = String(req.body?.note || '').trim();

    const scheduleId = transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO rehearsal_schedules (rehearsal_id, scene_id, start_at, end_at, start_ts, end_ts, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(r.id, sceneId, start.raw, end.raw, start.ts, end.ts, note, req.user.id);
      // 参与演员与其他未取消时段重叠 -> 抛错回滚，整次不生效
      assertNoScheduleConflicts({ scheduleId: info.lastInsertRowid });
      return info.lastInsertRowid;
    });
    res.status(201).json(serializeSchedule(getScheduleOfRehearsalOrThrow(scheduleId, r.id), r));
  })
);

// 日程列表：导演看全部（含待补派/待调整/已取消）；演员只看自己当前参与的有效时段
router.get(
  '/rehearsals/:id/schedules',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role === 'director') return res.json(directorSchedules(r));
    const cast = db
      .prepare('SELECT 1 FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ? LIMIT 1')
      .get(r.id, req.user.id);
    if (!cast) throw forbidden();
    res.json({ schedules: actorSchedules(r, req.user.id) });
  })
);

// 调整时段（导演）：仅未取消的安排可调整；冲突则整次拒绝
router.patch(
  '/rehearsals/:id/schedules/:scheduleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOfRehearsalOrThrow(req.params.scheduleId, r.id);
    if (s.status !== 'active') throw badRequest('已取消的安排不能调整时段');
    const start = req.body?.startAt !== undefined
      ? parseTimePoint(req.body.startAt, 'startAt')
      : { raw: s.start_at, ts: s.start_ts };
    const end = req.body?.endAt !== undefined
      ? parseTimePoint(req.body.endAt, 'endAt')
      : { raw: s.end_at, ts: s.end_ts };
    if (end.ts <= start.ts) throw badRequest('结束时间必须晚于开始时间');
    const note = req.body?.note !== undefined ? String(req.body.note).trim() : s.note;

    transaction(() => {
      db.prepare(
        'UPDATE rehearsal_schedules SET start_at = ?, end_at = ?, start_ts = ?, end_ts = ?, note = ? WHERE id = ?'
      ).run(start.raw, end.raw, start.ts, end.ts, note, s.id);
      assertNoScheduleConflicts({ scheduleId: s.id });
    });
    res.json(serializeSchedule(getScheduleOfRehearsalOrThrow(s.id, r.id), r));
  })
);

// 取消安排（导演）
router.post(
  '/rehearsals/:id/schedules/:scheduleId/cancel',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOfRehearsalOrThrow(req.params.scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('该安排已取消');
    db.prepare("UPDATE rehearsal_schedules SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(s.id);
    res.json({ ok: true, schedule: serializeSchedule(getScheduleOfRehearsalOrThrow(s.id, r.id), r) });
  })
);

// 演员：我的全部有效时段（跨排练）
router.get(
  '/my/schedules',
  wrap((req, res) => {
    const rehearsals = db.prepare('SELECT * FROM rehearsals ORDER BY id').all();
    const mine = [];
    for (const r of rehearsals) {
      mine.push(...actorSchedules(r, req.user.id));
    }
    mine.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.id - b.id);
    res.json({ schedules: mine });
  })
);

module.exports = {
  router,
  assertNoScheduleConflicts,
  directorSchedules,
  actorSchedules,
  serializeSchedule,
  listSchedules,
};
