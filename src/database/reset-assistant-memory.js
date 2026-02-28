import { allQuery, runQuery } from '../db.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const PRESERVED_TABLES = new Set([
  'counters',
  'word_game_state',
  'word_game_scores',
  'word_game_history'
]);

async function listUserTables() {
  const rows = await allQuery(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `);
  return rows.map(row => row.name);
}

async function printCounts(title, tables) {
  console.log(`\n=== ${title} ===`);
  let totalRows = 0;

  for (const tableName of tables) {
    const rows = await allQuery(`SELECT COUNT(*) AS c FROM ${tableName}`);
    const count = rows?.[0]?.c ?? 0;
    totalRows += count;
    console.log(`${tableName}: ${count}`);
  }

  console.log(`TOTAL ROWS: ${totalRows}`);
}

async function resetAssistantMemory() {
  const tables = await listUserTables();
  if (tables.length === 0) {
    console.log('Aucune table détectée, rien à reset.');
    return;
  }

  const tablesToClear = tables.filter(table => !PRESERVED_TABLES.has(table));
  const preservedFound = tables.filter(table => PRESERVED_TABLES.has(table));

  await printCounts('Avant reset', tables);

  if (preservedFound.length > 0) {
    console.log(`\nTables préservées (non vidées): ${preservedFound.join(', ')}`);
  }

  if (dryRun) {
    console.log(`\nDRY RUN: ${tablesToClear.length} table(s) seraient vidées, ${preservedFound.length} préservée(s).`);
    return;
  }

  await runQuery('BEGIN TRANSACTION');
  try {
    await runQuery('PRAGMA foreign_keys = OFF');

    for (const tableName of tablesToClear) {
      await runQuery(`DELETE FROM ${tableName}`);
      console.log(`Cleared table: ${tableName}`);
    }

    for (const tableName of tablesToClear) {
      await runQuery('DELETE FROM sqlite_sequence WHERE name = ?', [tableName]);
    }

    await runQuery('PRAGMA foreign_keys = ON');
    await runQuery('COMMIT');
  } catch (error) {
    await runQuery('ROLLBACK');
    await runQuery('PRAGMA foreign_keys = ON');
    throw error;
  }

  await printCounts('Après reset', tables);
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
