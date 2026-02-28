import { runQuery, getQuery, allQuery } from '../db.js';

const EMBEDDING_DIM = 64;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .slice(0, 200);
}

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function buildSemanticVector(text) {
  const vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const hash = hashToken(token);
    const position = hash % EMBEDDING_DIM;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[position] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

function cosineSimilarity(vectorA, vectorB) {
  if (!Array.isArray(vectorA) || !Array.isArray(vectorB)) return 0;
  if (vectorA.length !== vectorB.length || vectorA.length === 0) return 0;

  let dot = 0;
  for (let index = 0; index < vectorA.length; index += 1) {
    dot += vectorA[index] * vectorB[index];
  }
  return dot;
}

async function upsertMemoryEmbedding(memoryId, userId, memoryType, sourceText) {
  const normalizedText = String(sourceText || '').trim();
  if (!normalizedText) return;

  const embedding = buildSemanticVector(normalizedText);
  const now = new Date().toISOString();

  if (memoryId) {
    await runQuery(
      `DELETE FROM memory_embeddings WHERE memory_id = ?`,
      [memoryId]
    );
  }

  await runQuery(
    `INSERT INTO memory_embeddings (memory_id, user_id, memory_type, source_text, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [memoryId || null, userId || null, memoryType || 'memory', normalizedText, JSON.stringify(embedding), now]
  );
}

// Memories CRUD
async function addMemory(type, content, createdBy, subject = null, userId = null) {
  const createdAt = new Date().toISOString();
  const result = await runQuery(
    'INSERT INTO memories (type, subject, user_id, content, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [type, subject, userId, content, createdAt, createdBy]
  );

  if (!['conversation', 'vanne'].includes(type)) {
    await upsertMemoryEmbedding(result.lastID, userId, type, `${subject || ''} ${content}`.trim());
  }

  return result?.lastID || null;
}

async function getMemoriesForUser(userId, limit = 50, options = {}) {
  const { maxAgeDays = null } = options;
  const params = [userId];
  let sql = "SELECT * FROM memories WHERE user_id = ? AND type NOT IN ('conversation','vanne')";

  if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    sql += ' AND created_at >= ?';
    params.push(cutoff);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return await allQuery(
    sql,
    params
  );
}

async function searchMemories(keywords, options = {}) {
  const { userId = null, limit = 100, maxAgeDays = null } = options;
  const terms = keywords.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];

  let sql = "SELECT * FROM memories WHERE type NOT IN ('conversation','vanne')";
  const params = [];

  if (userId) {
    sql += ' AND (user_id = ? OR user_id IS NULL)';
    params.push(userId);
  }

  if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    sql += ' AND created_at >= ?';
    params.push(cutoff);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const results = await allQuery(sql, params);
  return results.filter(mem => {
    const searchText = `${mem.subject || ''} ${mem.content}`.toLowerCase();
    return terms.some(term => searchText.includes(term));
  });
}

async function searchMemoriesSemantic(query, options = {}) {
  const {
    userId = null,
    limit = 12,
    minScore = 0.2,
    maxAgeDays = 30
  } = options;

  const queryText = String(query || '').trim();
  if (!queryText) return [];

  const queryVector = buildSemanticVector(queryText);
  const params = [];

  let sql = `
    SELECT me.memory_id, me.user_id, me.memory_type, me.source_text, me.embedding, me.created_at, m.subject, m.content, m.type
    FROM memory_embeddings me
    LEFT JOIN memories m ON m.id = me.memory_id
    WHERE 1=1
  `;

  if (userId) {
    sql += ' AND (me.user_id = ? OR me.user_id IS NULL)';
    params.push(userId);
  }

  if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    sql += ' AND me.created_at >= ?';
    params.push(cutoff);
  }

  sql += ' ORDER BY me.created_at DESC LIMIT 200';

  const rows = await allQuery(sql, params);
  const scored = rows
    .map(row => {
      try {
        const vector = JSON.parse(row.embedding);
        const score = cosineSimilarity(queryVector, vector);
        return { row, score };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => ({
      ...item.row,
      semantic_score: Number(item.score.toFixed(4))
    }));

  return scored;
}

async function upsertUserMemorySlot(userId, updates = {}) {
  if (!userId) return;

  const existing = await getQuery('SELECT * FROM user_memory_slots WHERE user_id = ?', [userId]);
  const now = new Date().toISOString();

  const nextData = {
    objective: updates.objective ?? existing?.objective ?? null,
    pro_context: updates.pro_context ?? existing?.pro_context ?? null,
    preferences: updates.preferences ?? existing?.preferences ?? null,
    constraints: updates.constraints ?? existing?.constraints ?? null
  };

  await runQuery(
    `INSERT INTO user_memory_slots (user_id, objective, pro_context, preferences, constraints, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       objective = excluded.objective,
       pro_context = excluded.pro_context,
       preferences = excluded.preferences,
       constraints = excluded.constraints,
       updated_at = excluded.updated_at`,
    [userId, nextData.objective, nextData.pro_context, nextData.preferences, nextData.constraints, existing?.created_at || now, now]
  );

  const entries = Object.entries(nextData).filter(([, value]) => value && String(value).trim() !== '');
  for (const [slotKey, slotValue] of entries) {
    await upsertMemoryEmbedding(null, userId, `slot:${slotKey}`, `${slotKey} ${slotValue}`);
  }
}

async function getUserMemorySlots(userId) {
  if (!userId) return null;
  return await getQuery('SELECT * FROM user_memory_slots WHERE user_id = ?', [userId]);
}

async function extractAndStoreMemorySlots(userId, userMessage) {
  const text = String(userMessage || '').trim();
  if (!userId || !text) return false;

  const updates = {};

  const objectiveMatch = text.match(/(?:mon\s+objectif|objectif\s*:|je\s+veux|mon\s+but)\s*(?:est\s+de\s+)?(.+)/i);
  if (objectiveMatch && objectiveMatch[1]) {
    updates.objective = objectiveMatch[1].trim().slice(0, 280);
  }

  const proMatch = text.match(/(?:je\s+suis|je\s+bosse\s+comme|je\s+travaille\s+comme|job\s*:|boulot\s*:|m[ée]tier\s*:)(.+)/i);
  if (proMatch && proMatch[1]) {
    updates.pro_context = proMatch[1].trim().slice(0, 280);
  }

  const preferenceMatch = text.match(/(?:je\s+pr[ée]f[èe]re|pr[ée]f[ée]rence\s*:|j'aime\s+bien|j'aime\s+pas)\s+(.+)/i);
  if (preferenceMatch && preferenceMatch[1]) {
    updates.preferences = preferenceMatch[1].trim().slice(0, 280);
  }

  const constraintMatch = text.match(/(?:je\s+peux\s+pas|je\s+n'ai\s+pas|contrainte\s*:|limite\s*:|pas\s+de\s+temps|pas\s+d'argent)\s+(.+)/i);
  if (constraintMatch && constraintMatch[1]) {
    updates.constraints = constraintMatch[1].trim().slice(0, 280);
  }

  if (Object.keys(updates).length === 0) {
    return false;
  }

  await upsertUserMemorySlot(userId, updates);
  return true;
}

async function getAllMemories(limit = 50) {
  return await allQuery(
    'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

async function deleteMemory(memoryId) {
  await runQuery('DELETE FROM memories WHERE id = ?', [memoryId]);
}

// Conversation helpers
async function loadConversationHistory(userId, limit = 10, maxAgeHours = null) {
  let sql = `SELECT content FROM memories 
     WHERE user_id = ? AND type = 'conversation'`;
  const params = [userId];

  if (typeof maxAgeHours === 'number' && maxAgeHours > 0) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    sql += ' AND created_at >= ?';
    params.push(cutoff);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = await allQuery(sql, params);
  return rows.reverse();
}

// Prune old conversation memories to avoid confusion
async function pruneConversationMemory(userId, options = {}) {
  const { maxAgeHours = 24, maxPerUser = 80 } = options;
  if (!userId) return;

  if (typeof maxAgeHours === 'number' && maxAgeHours > 0) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    await runQuery(
      `DELETE FROM memories
       WHERE type = 'conversation'
       AND user_id = ?
       AND created_at < ?`,
      [userId, cutoff]
    );
  }

  if (typeof maxPerUser === 'number' && maxPerUser > 0) {
    await runQuery(
      `DELETE FROM memories
       WHERE type = 'conversation'
       AND user_id = ?
       AND id NOT IN (
         SELECT id FROM memories
         WHERE type = 'conversation' AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       )`,
      [userId, userId, maxPerUser]
    );
  }
}

async function loadVannesContext(userId, limit = 5) {
  const rows = await allQuery(
    `SELECT content FROM memories 
     WHERE type = 'vanne' AND (user_id = ? OR subject LIKE ?)
     ORDER BY created_at DESC LIMIT ?`,
    [userId, `%${userId}%`, limit]
  );
  if (!rows || rows.length === 0) return '';
  let vannesInfo = '**Vannes/blagues mémorables:**\n';
  for (const row of rows) {
    try {
      const vanne = JSON.parse(row.content);
      vannesInfo += `- ${vanne.from} → ${vanne.to}: "${vanne.text}"\n`;
    } catch {
      // skip malformed
    }
  }
  return vannesInfo;
}

// Knowledge & snapshots
async function addFact(factType, subject, data, importance = 0.5) {
  await runQuery(
    'INSERT INTO facts (fact_type, subject, data, importance, created_at) VALUES (?, ?, ?, ?, ?)',
    [factType, subject, JSON.stringify(data), importance, new Date().toISOString()]
  );
}

async function addSummary(scope, period, content) {
  await runQuery(
    'INSERT INTO summaries (scope, period, content, created_at) VALUES (?, ?, ?, ?)',
    [scope, period, content, new Date().toISOString()]
  );
}

async function addAttachment(url, description, sourceUserId, sourceMessageId, metadata = {}) {
  await runQuery(
    'INSERT INTO attachments (url, description, source_user_id, source_message_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [url, description, sourceUserId, sourceMessageId, JSON.stringify(metadata), new Date().toISOString()]
  );
}

async function addTask(title, createdBy, assignedTo = null, details = {}) {
  await runQuery(
    'INSERT INTO tasks (title, status, created_by, assigned_to, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, 'open', createdBy, assignedTo, JSON.stringify(details), new Date().toISOString(), new Date().toISOString()]
  );
}

async function updateTaskStatus(taskId, status) {
  await runQuery(
    'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
    [status, new Date().toISOString(), taskId]
  );
}

async function addRawObservation(observationType, source, data) {
  await runQuery(
    'INSERT INTO raw_observations (observation_type, source, data, created_at) VALUES (?, ?, ?, ?)',
    [observationType, source, JSON.stringify(data), new Date().toISOString()]
  );
}

// Known members management
async function setKnownMember(discordId, realName, addedBy) {
  await runQuery(
    `INSERT INTO known_members (discord_id, real_name, added_at, added_by) 
     VALUES (?, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET real_name = ?, added_at = ?`,
    [discordId, realName, new Date().toISOString(), addedBy, realName, new Date().toISOString()]
  );
}

async function removeKnownMember(discordId) {
  await runQuery('DELETE FROM known_members WHERE discord_id = ?', [discordId]);
}

async function listKnownMembers() {
  return await allQuery('SELECT discord_id, real_name, added_at FROM known_members ORDER BY added_at DESC');
}

export {
  addMemory,
  getMemoriesForUser,
  searchMemories,
  searchMemoriesSemantic,
  getAllMemories,
  deleteMemory,
  loadConversationHistory,
  pruneConversationMemory,
  loadVannesContext,
  addFact,
  addSummary,
  addAttachment,
  addTask,
  updateTaskStatus,
  addRawObservation,
  setKnownMember,
  removeKnownMember,
  listKnownMembers,
  upsertMemoryEmbedding,
  upsertUserMemorySlot,
  getUserMemorySlots,
  extractAndStoreMemorySlots
};
