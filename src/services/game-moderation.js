import { allQuery, getQuery, runQuery } from '../db.js';
import { openai } from '../ai/clients.js';

const DAILY_CHANCES_LIMIT = 2;
const MEDIUM_WINDOW_MS = 10 * 60 * 1000;
const MEDIUM_THRESHOLD = 3;
const GAGE_MONITORING_MS = 24 * 60 * 60 * 1000;
const AUTO_WHITELIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_WHITELIST_MIN_EVENTS = 8;

function getParisDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function parseJsonSafely(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function resolveConfidenceLevel(confidence) {
  if (confidence >= 0.9) {
    return 'HIGH';
  }
  if (confidence >= 0.75) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function isAutoWhitelistSource(source) {
  return typeof source === 'string' && source.startsWith('auto_');
}

async function reconcileAutoWhitelistForUser(guildId, userId) {
  const sinceIso = new Date(Date.now() - AUTO_WHITELIST_WINDOW_MS).toISOString();

  const stats = await getQuery(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN confidence_level = 'HIGH' THEN 1 ELSE 0 END) AS high_count,
      SUM(CASE WHEN confidence_level = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_count
     FROM game_infraction_events
     WHERE guild_id = ? AND user_id = ? AND created_at >= ?`,
    [guildId, userId, sinceIso]
  );

  const current = await getQuery(
    `SELECT source FROM game_whitelist WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId]
  );

  const total = Number(stats?.total || 0);
  const highCount = Number(stats?.high_count || 0);
  const mediumCount = Number(stats?.medium_count || 0);

  if (highCount > 0 && isAutoWhitelistSource(current?.source)) {
    await removeWhitelistUser(guildId, userId);
    return;
  }

  const qualifies = total >= AUTO_WHITELIST_MIN_EVENTS && highCount === 0 && mediumCount <= 1;
  if (!qualifies) {
    return;
  }

  const confidence = Math.max(0.8, Math.min(0.98, 0.8 + ((total - AUTO_WHITELIST_MIN_EVENTS) * 0.01)));
  await addWhitelistUser(guildId, userId, 'system', 'auto_ai_7d', confidence);
}

export async function isWhitelisted(guildId, userId) {
  const row = await getQuery(
    `SELECT 1 AS found FROM game_whitelist WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId]
  );
  return Boolean(row?.found);
}

export async function addWhitelistUser(guildId, userId, addedBy, source = 'manual', confidence = null) {
  await runQuery(
    `INSERT INTO game_whitelist (guild_id, user_id, source, confidence, added_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
      source = excluded.source,
      confidence = excluded.confidence,
      added_at = excluded.added_at,
      added_by = excluded.added_by`,
    [guildId, userId, source, confidence, new Date().toISOString(), addedBy]
  );
}

export async function removeWhitelistUser(guildId, userId) {
  await runQuery(
    `DELETE FROM game_whitelist WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId]
  );
}

export async function listWhitelistUsers(guildId) {
  return allQuery(
    `SELECT user_id, source, confidence, added_at, added_by
     FROM game_whitelist
     WHERE guild_id = ?
     ORDER BY added_at DESC`,
    [guildId]
  );
}

export async function getSanction(guildId, userId) {
  return getQuery(
    `SELECT active, reason, source, created_at, created_by, lifted_at, lifted_by
     FROM game_sanctions
     WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId]
  );
}

export async function isGamesSanctioned(guildId, userId) {
  const row = await getQuery(
    `SELECT active FROM game_sanctions WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId]
  );
  return row?.active === 1;
}

export async function applyGamesSanction(guildId, userId, reason, source, actorId) {
  await runQuery(
    `INSERT INTO game_sanctions (guild_id, user_id, active, reason, source, created_at, created_by, lifted_at, lifted_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
      active = 1,
      reason = excluded.reason,
      source = excluded.source,
      created_at = excluded.created_at,
      created_by = excluded.created_by,
      lifted_at = NULL,
      lifted_by = NULL`,
    [guildId, userId, reason, source, new Date().toISOString(), actorId]
  );
}

export async function liftGamesSanction(guildId, userId, actorId) {
  await runQuery(
    `UPDATE game_sanctions
     SET active = 0,
         lifted_at = ?,
         lifted_by = ?
     WHERE guild_id = ? AND user_id = ?`,
    [new Date().toISOString(), actorId, guildId, userId]
  );
}

export async function consumeDailyChance(guildId, userId, amount = 1) {
  const dateKey = getParisDateKey();
  const nowIso = new Date().toISOString();

  await runQuery(
    `INSERT INTO game_daily_chances (guild_id, user_id, date_key, chances_used, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, date_key) DO UPDATE SET
      chances_used = game_daily_chances.chances_used + ?,
      updated_at = excluded.updated_at`,
    [guildId, userId, dateKey, amount, nowIso, amount]
  );

  const row = await getQuery(
    `SELECT chances_used FROM game_daily_chances WHERE guild_id = ? AND user_id = ? AND date_key = ?`,
    [guildId, userId, dateKey]
  );

  const used = Number(row?.chances_used || 0);
  return {
    used,
    remaining: Math.max(0, DAILY_CHANCES_LIMIT - used),
    exhausted: used >= DAILY_CHANCES_LIMIT
  };
}

export async function getDailyChances(guildId, userId) {
  const dateKey = getParisDateKey();
  const row = await getQuery(
    `SELECT chances_used FROM game_daily_chances WHERE guild_id = ? AND user_id = ? AND date_key = ?`,
    [guildId, userId, dateKey]
  );

  const used = Number(row?.chances_used || 0);
  return {
    used,
    remaining: Math.max(0, DAILY_CHANCES_LIMIT - used),
    exhausted: used >= DAILY_CHANCES_LIMIT,
    limit: DAILY_CHANCES_LIMIT
  };
}

export async function recordInfractionEvent({
  guildId,
  channelId,
  userId,
  gameType,
  eventType,
  aiConfidence = null,
  confidenceLevel = null,
  details = null
}) {
  await runQuery(
    `INSERT INTO game_infraction_events (
      guild_id, channel_id, user_id, game_type, event_type, ai_confidence, confidence_level, details, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      guildId,
      channelId || null,
      userId,
      gameType,
      eventType,
      aiConfidence,
      confidenceLevel,
      details ? JSON.stringify(details) : null,
      new Date().toISOString()
    ]
  );

  await reconcileAutoWhitelistForUser(guildId, userId);
}

export async function applyGenericGameModerationDecision({ guildId, channelId, userId, gameType, details }) {
  const heuristic = 0.45;
  let confidence = heuristic;
  let reason = 'Comportement possiblement non intentionnel.';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Tu classes un événement de jeu Discord en sabotage volontaire ou erreur. Réponds strictement JSON: {"confidence": number entre 0 et 1, "reason": string courte}. confidence = probabilité de sabotage.'
        },
        {
          role: 'user',
          content: JSON.stringify({ gameType, details })
        }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const parsed = parseJsonSafely(raw);
    const parsedConfidence = Number(parsed?.confidence);
    if (Number.isFinite(parsedConfidence)) {
      confidence = Math.max(0, Math.min(1, parsedConfidence));
    }
    if (parsed?.reason) {
      reason = String(parsed.reason);
    }
  } catch {
    confidence = heuristic;
    reason = 'Fallback local (IA indisponible).';
  }

  const level = resolveConfidenceLevel(confidence);

  await recordInfractionEvent({
    guildId,
    channelId,
    userId,
    gameType,
    eventType: level === 'HIGH' ? 'sabotage_high' : level === 'MEDIUM' ? 'sabotage_suspect' : 'human_error',
    aiConfidence: confidence,
    confidenceLevel: level,
    details: { ...details, reason }
  });

  if (level === 'HIGH') {
    const chanceState = await consumeDailyChance(guildId, userId, 1);
    if (chanceState.exhausted) {
      await applyGamesSanction(
        guildId,
        userId,
        `2 chances quotidiennes épuisées (${gameType})`,
        'quota_exhausted',
        'system'
      );
    }
    return { level, confidence, reason, consumed: 1, chanceState, sanctioned: chanceState.exhausted };
  }

  return {
    level,
    confidence,
    reason,
    consumed: 0,
    chanceState: await getDailyChances(guildId, userId),
    sanctioned: false
  };
}

export async function countRecentMediumSuspicion(guildId, userId, gameType) {
  const thresholdIso = new Date(Date.now() - MEDIUM_WINDOW_MS).toISOString();
  const row = await getQuery(
    `SELECT COUNT(*) AS total
     FROM game_infraction_events
     WHERE guild_id = ?
       AND user_id = ?
       AND game_type = ?
       AND confidence_level = 'MEDIUM'
       AND created_at >= ?`,
    [guildId, userId, gameType, thresholdIso]
  );

  return Number(row?.total || 0);
}

export async function evaluateCountingSabotage({ expected, submitted, isSameUser }) {
  if (typeof submitted !== 'number' || Number.isNaN(submitted)) {
    return {
      confidence: 0.2,
      level: 'LOW',
      eventType: 'invalid_format',
      reason: 'Valeur non numérique ou invalide.'
    };
  }

  const expectedText = String(expected);
  const submittedText = String(submitted);
  const commonDigits = expectedText.split('').filter((digit) => submittedText.includes(digit)).length;
  const localHeuristic = commonDigits === 0 ? 0.92 : 0.35;
  const delta = Math.abs(submitted - expected);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Tu es un classifieur anti-sabotage pour un jeu counting Discord. Réponds strictement en JSON: {"confidence": number entre 0 et 1, "reason": string courte}. Confidence = probabilité de sabotage volontaire. Ignore les insultes, sois factuel.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            game: 'counting',
            expected,
            submitted,
            delta,
            isSameUser,
            commonDigits,
            heuristic: localHeuristic
          })
        }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const parsed = parseJsonSafely(raw);
    const aiConfidenceRaw = Number(parsed?.confidence);
    const aiConfidence = Number.isFinite(aiConfidenceRaw)
      ? Math.max(0, Math.min(1, aiConfidenceRaw))
      : localHeuristic;

    const confidence = Math.max(localHeuristic, aiConfidence);
    const level = resolveConfidenceLevel(confidence);
    return {
      confidence,
      level,
      eventType: level === 'HIGH' ? 'sabotage_high' : level === 'MEDIUM' ? 'sabotage_suspect' : 'human_error',
      reason: String(parsed?.reason || `Analyse IA (${level})`)
    };
  } catch {
    const confidence = localHeuristic >= 0.9 ? 0.9 : 0.2;
    return {
      confidence,
      level: resolveConfidenceLevel(confidence),
      eventType: confidence >= 0.9 ? 'sabotage_high_fallback' : 'human_error_fallback',
      reason: 'Fallback local (IA indisponible).'
    };
  }
}

export async function applyCountingModerationDecision({ guildId, channelId, userId, expected, submitted, isSameUser }) {
  const assessment = await evaluateCountingSabotage({ expected, submitted, isSameUser });

  await recordInfractionEvent({
    guildId,
    channelId,
    userId,
    gameType: 'counting',
    eventType: assessment.eventType,
    aiConfidence: assessment.confidence,
    confidenceLevel: assessment.level,
    details: { expected, submitted, isSameUser, reason: assessment.reason }
  });

  if (assessment.level === 'HIGH') {
    const chanceState = await consumeDailyChance(guildId, userId, 1);
    if (chanceState.exhausted) {
      await applyGamesSanction(
        guildId,
        userId,
        '2 chances quotidiennes épuisées (counting sabotage détecté)',
        'quota_exhausted',
        'system'
      );
    }
    return {
      ...assessment,
      consumed: 1,
      chanceState,
      sanctioned: chanceState.exhausted
    };
  }

  if (assessment.level === 'MEDIUM') {
    const mediumCount = await countRecentMediumSuspicion(guildId, userId, 'counting');
    if (mediumCount >= MEDIUM_THRESHOLD) {
      const chanceState = await consumeDailyChance(guildId, userId, DAILY_CHANCES_LIMIT);
      await applyGamesSanction(
        guildId,
        userId,
        'Suspicions répétées de sabotage (counting)',
        'suspicion_burst',
        'system'
      );
      return {
        ...assessment,
        consumed: DAILY_CHANCES_LIMIT,
        chanceState,
        sanctioned: true,
        escalated: true
      };
    }
  }

  return {
    ...assessment,
    consumed: 0,
    chanceState: await getDailyChances(guildId, userId),
    sanctioned: false
  };
}

export async function canAccessGames(guildId, userId) {
  const whitelisted = await isWhitelisted(guildId, userId);
  if (whitelisted) {
    return { allowed: true, reason: 'whitelisted' };
  }

  const sanctioned = await isGamesSanctioned(guildId, userId);
  if (sanctioned) {
    return { allowed: false, reason: 'sanctioned' };
  }

  return { allowed: true, reason: 'ok' };
}

export async function startGageMonitoring({
  guildId,
  threadId,
  targetUserId,
  assignedBy,
  challengeText,
  monitoringType = 'standard',
  baselineAvatarHash = null,
  baselineAvatarUrl = null
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GAGE_MONITORING_MS);

  await runQuery(
    `INSERT INTO gage_monitoring (
      guild_id, thread_id, target_user_id, assigned_by, challenge_text, started_at, expires_at, status
      , monitoring_type, baseline_avatar_hash, baseline_avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(guild_id, thread_id, target_user_id) DO UPDATE SET
      assigned_by = excluded.assigned_by,
      challenge_text = excluded.challenge_text,
      started_at = excluded.started_at,
      expires_at = excluded.expires_at,
      status = 'active',
      monitoring_type = excluded.monitoring_type,
      baseline_avatar_hash = excluded.baseline_avatar_hash,
      baseline_avatar_url = excluded.baseline_avatar_url,
      avatar_changed = 0,
      last_ai_confidence = NULL,
      last_ai_level = NULL,
      last_ai_reason = NULL`,
    [
      guildId,
      threadId,
      targetUserId,
      assignedBy || null,
      challengeText || null,
      now.toISOString(),
      expiresAt.toISOString(),
      monitoringType,
      baselineAvatarHash,
      baselineAvatarUrl
    ]
  );
}

export async function getActiveGageByThread(guildId, threadId) {
  return getQuery(
    `SELECT * FROM gage_monitoring WHERE guild_id = ? AND thread_id = ? AND status = 'active'`,
    [guildId, threadId]
  );
}

export async function updateGageAiAssessment({ guildId, threadId, targetUserId, confidence, level, reason }) {
  await runQuery(
    `UPDATE gage_monitoring
     SET last_ai_confidence = ?,
         last_ai_level = ?,
         last_ai_reason = ?
     WHERE guild_id = ? AND thread_id = ? AND target_user_id = ? AND status = 'active'`,
    [confidence, level, reason, guildId, threadId, targetUserId]
  );
}

export async function completeGageAndPurge(guildId, userId) {
  await runQuery(
    `DELETE FROM gage_monitoring WHERE guild_id = ? AND target_user_id = ?`,
    [guildId, userId]
  );
}

export async function listActiveAvatarGages() {
  return allQuery(
    `SELECT id, guild_id, thread_id, target_user_id, expires_at, baseline_avatar_hash, avatar_changed
     FROM gage_monitoring
     WHERE status = 'active' AND monitoring_type = 'avatar_24h'`
  );
}

export async function markAvatarGageChanged(gageId) {
  await runQuery(
    `UPDATE gage_monitoring SET avatar_changed = 1 WHERE id = ?`,
    [gageId]
  );
}

export async function startAvatarGageWindow(gageId, baselineAvatarHash, baselineAvatarUrl = null) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GAGE_MONITORING_MS);
  await runQuery(
    `UPDATE gage_monitoring
     SET avatar_changed = 1,
         baseline_avatar_hash = ?,
         baseline_avatar_url = ?,
         started_at = ?,
         expires_at = ?
     WHERE id = ?`,
    [
      baselineAvatarHash,
      baselineAvatarUrl,
      now.toISOString(),
      expiresAt.toISOString(),
      gageId
    ]
  );
}

export async function completeGageById(gageId) {
  await runQuery(
    `DELETE FROM gage_monitoring WHERE id = ?`,
    [gageId]
  );
}

export async function markGageFailedAndSanction(guildId, userId, actorId = 'system') {
  await applyGamesSanction(
    guildId,
    userId,
    'Gage assigné non accompli',
    'gage_failed',
    actorId
  );
}

export async function cleanupExpiredGages() {
  const nowIso = new Date().toISOString();

  const expired = await allQuery(
    `SELECT id, guild_id, target_user_id, monitoring_type
     FROM gage_monitoring
     WHERE status = 'active' AND expires_at < ?`,
    [nowIso]
  );

  for (const row of expired) {
    if (row.monitoring_type === 'avatar_24h') {
      const avatarRow = await getQuery('SELECT avatar_changed FROM gage_monitoring WHERE id = ?', [row.id]);
      if (Number(avatarRow?.avatar_changed || 0) === 0) {
        await markGageFailedAndSanction(row.guild_id, row.target_user_id, 'system');
      }
      continue;
    }
    await markGageFailedAndSanction(row.guild_id, row.target_user_id, 'system');
  }

  await runQuery(
    `DELETE FROM gage_monitoring WHERE expires_at < ? OR status = 'completed'`,
    [nowIso]
  );

  return expired.length;
}

export async function evaluateGageProgress(messageContent) {
  const trimmed = String(messageContent || '').trim();
  if (!trimmed) {
    return { confidence: 0.1, level: 'LOW', reason: 'Message vide.' };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Tu analyses un message de thread de gage. Retourne strictement JSON: {"confidence": number entre 0 et 1, "reason": string courte}. Confidence = probabilité que le message indique un progrès réel vers l\'accomplissement du gage.'
        },
        {
          role: 'user',
          content: JSON.stringify({ content: trimmed.slice(0, 500) })
        }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const parsed = parseJsonSafely(raw);
    const confidenceRaw = Number(parsed?.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.2;

    return {
      confidence,
      level: resolveConfidenceLevel(confidence),
      reason: String(parsed?.reason || 'Analyse progression gage')
    };
  } catch {
    return {
      confidence: 0.2,
      level: 'LOW',
      reason: 'IA indisponible pendant surveillance du gage.'
    };
  }
}
