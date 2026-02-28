import { getQuery, runQuery } from '../db.js';

const PREFERENCE_COLUMN_MAP = {
  model: 'ai_model_preference',
  style: 'response_style',
  language: 'language'
};

export async function getUserPreferences(userId) {
  if (!userId) return null;
  return await getQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
}

export async function setUserPreference(userId, type, value) {
  if (!userId) {
    throw new Error('userId requis');
  }

  const column = PREFERENCE_COLUMN_MAP[type];
  if (!column) {
    throw new Error(`Type de préférence invalide: ${type}`);
  }

  const now = new Date().toISOString();
  await runQuery(
    `INSERT INTO user_preferences (user_id, ${column}, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET ${column} = ?, updated_at = ?`,
    [userId, value, now, now, value, now]
  );
}

export async function resetUserPreferences(userId) {
  if (!userId) return;
  await runQuery('DELETE FROM user_preferences WHERE user_id = ?', [userId]);
}
