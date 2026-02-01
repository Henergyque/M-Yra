import { runQuery, getQuery, allQuery } from '../db.js';

// Memories CRUD
async function addMemory(type, content, createdBy, subject = null, userId = null) {
  await runQuery(
    'INSERT INTO memories (type, subject, user_id, content, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [type, subject, userId, content, new Date().toISOString(), createdBy]
  );
}

async function getMemoriesForUser(userId, limit = 50) {
  return await allQuery(
    "SELECT * FROM memories WHERE user_id = ? AND type NOT IN ('conversation','vanne') ORDER BY created_at DESC LIMIT ?",
    [userId, limit]
  );
}

async function searchMemories(keywords, options = {}) {
  const { userId = null, limit = 100 } = options;
  const terms = keywords.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];

  let sql = "SELECT * FROM memories WHERE type NOT IN ('conversation','vanne')";
  const params = [];

  if (userId) {
    sql += ' AND (user_id = ? OR user_id IS NULL)';
    params.push(userId);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const results = await allQuery(sql, params);
  return results.filter(mem => {
    const searchText = `${mem.subject || ''} ${mem.content}`.toLowerCase();
    return terms.some(term => searchText.includes(term));
  });
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
  listKnownMembers
};
