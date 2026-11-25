import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { articleDecodeVersion, decodeArticleFields, discussionKey } from './article.js';
import { groupNamePattern, syncConfig } from './config.js';
import { initializeDatabase, openDatabase, refreshArticleText } from './db.js';
import { NntpClient } from './nntp.js';

const numberWindow = 1000n;
const groupBatchSize = 500;

async function usingNntp(config, signal, work) {
  signal.throwIfAborted();
  const nntp = new NntpClient(config);
  const abort = () => nntp.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await nntp.ready();
    return await work(nntp);
  } finally {
    signal.removeEventListener('abort', abort);
    nntp.close();
  }
}

async function stageGroups(db, groups) {
  await db.query(`
    INSERT INTO incoming_groups (name, low_article, high_article, remote_status)
    SELECT name, low, high, status
    FROM jsonb_to_recordset($1::jsonb) AS items(name text, low bigint, high bigint, status text)
    ON CONFLICT (name) DO NOTHING
  `, [JSON.stringify(groups)]);
}

async function syncCatalog(db, nntp, host, signal) {
  await db.query('BEGIN');
  try {
    await db.query(`
      CREATE TEMP TABLE incoming_groups (
        name text COLLATE "C" PRIMARY KEY,
        low_article bigint NOT NULL,
        high_article bigint NOT NULL,
        remote_status text NOT NULL
      ) ON COMMIT DROP
    `);
    let batch = [];
    for await (const group of nntp.listGroups()) {
      batch.push(group);
      if (batch.length === groupBatchSize) {
        await stageGroups(db, batch);
        batch = [];
      }
    }
    signal.throwIfAborted();
    if (batch.length) await stageGroups(db, batch);

    const { rowCount } = await db.query(`
      INSERT INTO usenet_groups (source, name, low_article, high_article, remote_status)
      SELECT $1, name, low_article, high_article, remote_status FROM incoming_groups
      ON CONFLICT (source, name) DO UPDATE SET
        low_article = EXCLUDED.low_article,
        high_article = EXCLUDED.high_article,
        remote_status = EXCLUDED.remote_status,
        active = true
      WHERE (usenet_groups.low_article, usenet_groups.high_article, usenet_groups.remote_status, usenet_groups.active)
        IS DISTINCT FROM (EXCLUDED.low_article, EXCLUDED.high_article, EXCLUDED.remote_status, true)
    `, [host]);
    await db.query(`
      UPDATE usenet_groups AS g SET active = false
      WHERE source = $1 AND active
        AND NOT EXISTS (SELECT 1 FROM incoming_groups AS i WHERE i.name = g.name)
    `, [host]);
    const { rows: [total] } = await db.query('SELECT count(*) AS count FROM incoming_groups');
    await db.query('COMMIT');
    console.log(`组目录：${total.count} 个，新增或更新 ${rowCount} 个。`);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function storeArticle(db, groupId, number, article) {
  const fields = await decodeArticleFields(article.raw);
  const messageId = fields.messageId || (article.messageId || '').replaceAll('\0', '�');
  await db.query(`
    WITH added AS (
      INSERT INTO usenet_articles
        (group_id, number, message_id, subject, author, posted_at, body, source_text, raw, thread_key, decode_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (group_id, number) DO NOTHING
      RETURNING number
    )
    UPDATE usenet_groups
    SET synced_through = $2, article_count = article_count + (SELECT count(*) FROM added)
    WHERE id = $1
  `, [
    groupId, number.toString(), messageId,
    fields.subject, fields.author, fields.postedAt, fields.body, fields.sourceText, article.raw,
    discussionKey(article.raw.subarray(0, 65536), messageId), articleDecodeVersion,
  ]);
}

async function syncGroup(db, nntp, group, initialLimit, signal) {
  const { low, high } = await nntp.selectGroup(group.name);
  let start = low > 0n ? low : 1n;
  if (group.synced_through !== null) {
    const next = BigInt(group.synced_through) + 1n;
    if (next > start) start = next;
  } else if (initialLimit > 0n) {
    const recent = high - initialLimit + 1n;
    if (recent > start) start = recent;
  }

  let downloaded = 0;
  let supportsListGroup = true;
  while (start <= high) {
    signal.throwIfAborted();
    let end = start + numberWindow - 1n;
    if (end > high) end = high;
    const listed = supportsListGroup ? await nntp.listNumbers(group.name, start, end) : null;
    supportsListGroup = listed !== null;
    const numbers = listed ?? Array.from({ length: Number(end - start + 1n) }, (_, index) => start + BigInt(index));
    for (const number of numbers) {
      signal.throwIfAborted();
      const article = await nntp.fetchArticle(number);
      if (article) {
        await storeArticle(db, group.id, number, article);
        downloaded += 1;
      }
    }
    await db.query('UPDATE usenet_groups SET synced_through = $2 WHERE id = $1', [group.id, end.toString()]);
    start = end + 1n;
  }
  await db.query(`
    UPDATE usenet_groups
    SET low_article = $2, high_article = $3, synced_at = now()
    WHERE id = $1
  `, [group.id, low.toString(), high.toString()]);
  if (downloaded) console.log(`${group.name}：拉取 ${downloaded} 篇文章。`);
  return downloaded;
}

async function synchronize(pool, config, signal) {
  const db = await pool.connect();
  try {
    const { rows: [lock] } = await db.query(`
      SELECT pg_try_advisory_lock(hashtextextended('cnusenet:nntp:' || $1::text, 0)) AS acquired
    `, [config.host]);
    if (!lock.acquired) {
      console.log('该来源已有同步任务，跳过本轮。');
      return;
    }

    await usingNntp(config, signal, nntp => syncCatalog(db, nntp, config.host, signal));
    if (!config.groups.length) return;

    const all = config.groups.includes('*');
    const { rows: groups } = await db.query(`
      SELECT id, name, synced_through FROM usenet_groups
      WHERE source = $1 AND active AND ($2::boolean OR name = ANY($3::text[]))
      ORDER BY name
    `, [config.host, all, config.groups]);

    const available = new Set(groups.map(group => group.name));
    const missing = all ? [] : config.groups.filter(name => !available.has(name));
    for (const name of missing) console.error(`组目录中找不到 ${name}。`);

    let failed = missing.length;
    let downloaded = 0;
    for (const group of groups) {
      try {
        if (!groupNamePattern.test(group.name)) throw new Error('组名格式不受支持');
        downloaded += await usingNntp(config, signal, nntp => syncGroup(db, nntp, group, config.initialLimit, signal));
      } catch (error) {
        signal.throwIfAborted();
        console.error(`${group.name}：${error.message}`);
        failed += 1;
      }
    }
    console.log(`文章同步结束，共拉取 ${downloaded} 篇。`);
    if (failed) throw new Error(`${failed} 个组未完成同步。`);
  } finally {
    // Closing this session releases the advisory lock even if a query failed.
    db.release(true);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      group: { type: 'string', multiple: true },
      'groups-only': { type: 'boolean' },
      watch: { type: 'boolean' },
    },
  });
  const config = syncConfig();
  if (values['groups-only'] && values.group) throw new Error('--groups-only 与 --group 只能使用一个。');
  if (values['groups-only']) config.groups = [];
  if (values.group) config.groups = [...new Set(values.group)];
  if (config.groups.some(name => name !== '*' && !groupNamePattern.test(name))) {
    throw new Error('NNTP_GROUPS 或 --group 中存在无效的组名。');
  }

  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  const pool = openDatabase(config.databaseUrl);
  try {
    await initializeDatabase(pool);
    await refreshArticleText(pool, stop.signal);
    while (!stop.signal.aborted) {
      try {
        await synchronize(pool, config, stop.signal);
      } catch (error) {
        if (stop.signal.aborted) break;
        if (!values.watch) throw error;
        console.error(error.message);
      }
      if (!values.watch || stop.signal.aborted) break;
      await delay(config.intervalSeconds * 1000, undefined, { signal: stop.signal })
        .catch(error => { if (!stop.signal.aborted) throw error; });
    }
  } finally {
    await pool.end();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
