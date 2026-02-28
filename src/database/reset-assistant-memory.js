import { allQuery, runQuery } from '../db.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const RESET_QUERIES = [
  { label: 'conversation memories', sql: "DELETE FROM memories WHERE type = 'conversation'" },
  { label: 'joke memories', sql: "DELETE FROM memories WHERE type = 'vanne'" },
  { label: 'facts', sql: 'DELETE FROM facts' },
  { label: 'summaries', sql: 'DELETE FROM summaries' },
  { label: 'attachments', sql: 'DELETE FROM attachments' },
  { label: 'tasks', sql: 'DELETE FROM tasks' },
  { label: 'raw observations', sql: 'DELETE FROM raw_observations' },
  { label: 'known members', sql: 'DELETE FROM known_members' },
  { label: 'brain observations', sql: 'DELETE FROM brain_observations' },
  { label: 'brain events', sql: 'DELETE FROM brain_events' },
  { label: 'brain member patterns', sql: 'DELETE FROM brain_member_patterns' },
  { label: 'brain context knowledge', sql: 'DELETE FROM brain_context_knowledge' },
  { label: 'brain relationships', sql: 'DELETE FROM brain_relationships' },
  { label: 'ai performance', sql: 'DELETE FROM ai_performance' },
  { label: 'ai decisions', sql: 'DELETE FROM ai_decisions' }
];

const COUNT_QUERIES = [
  { label: 'memories total', sql: 'SELECT COUNT(*) AS c FROM memories' },
  { label: 'memories conversation', sql: "SELECT COUNT(*) AS c FROM memories WHERE type = 'conversation'" },
  { label: 'memories vanne', sql: "SELECT COUNT(*) AS c FROM memories WHERE type = 'vanne'" },
  { label: 'facts', sql: 'SELECT COUNT(*) AS c FROM facts' },
  { label: 'summaries', sql: 'SELECT COUNT(*) AS c FROM summaries' },
  { label: 'attachments', sql: 'SELECT COUNT(*) AS c FROM attachments' },
  { label: 'tasks', sql: 'SELECT COUNT(*) AS c FROM tasks' },
  { label: 'raw observations', sql: 'SELECT COUNT(*) AS c FROM raw_observations' },
  { label: 'known members', sql: 'SELECT COUNT(*) AS c FROM known_members' },
  { label: 'brain observations', sql: 'SELECT COUNT(*) AS c FROM brain_observations' },
  { label: 'brain events', sql: 'SELECT COUNT(*) AS c FROM brain_events' },
  { label: 'brain member patterns', sql: 'SELECT COUNT(*) AS c FROM brain_member_patterns' },
  { label: 'brain context knowledge', sql: 'SELECT COUNT(*) AS c FROM brain_context_knowledge' },
  { label: 'brain relationships', sql: 'SELECT COUNT(*) AS c FROM brain_relationships' },
  { label: 'ai performance', sql: 'SELECT COUNT(*) AS c FROM ai_performance' },
  { label: 'ai decisions', sql: 'SELECT COUNT(*) AS c FROM ai_decisions' }
];

async function printCounts(title) {
  console.log(`\n=== ${title} ===`);
  for (const query of COUNT_QUERIES) {
    const rows = await allQuery(query.sql);
    const count = rows?.[0]?.c ?? 0;
    console.log(`${query.label}: ${count}`);
  }
}

async function resetAssistantMemory() {
  await printCounts('Avant reset');

  if (dryRun) {
    console.log('\nDRY RUN: aucune suppression effectuée.');
    return;
  }

  await runQuery('BEGIN TRANSACTION');
  try {
    for (const query of RESET_QUERIES) {
      await runQuery(query.sql);
      console.log(`Cleared: ${query.label}`);
    }
    await runQuery('COMMIT');
  } catch (error) {
    await runQuery('ROLLBACK');
    throw error;
  }

  await printCounts('Après reset');
}

resetAssistantMemory()
  .then(() => {
    console.log('\n✅ Assistant memory reset terminé.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Assistant memory reset échoué:', error.message);
    process.exit(1);
  });
