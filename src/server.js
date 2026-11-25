import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { articleNumber, webConfig } from './config.js';
import { initializeDatabase, openDatabase } from './db.js';
import { articleColumns, articleFilters, searchText } from './reading.js';
import { archivePage, errorPage } from './views.js';

const pageSize = 24;

function paginate(rows, backwards, cursor) {
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  if (backwards) items.reverse();
  return {
    items,
    previous: backwards ? hasMore : Boolean(cursor),
    next: backwards ? Boolean(cursor) : hasMore,
  };
}

async function readGroups(db, host, params) {
  const filter = searchText(params.get('q'));
  const populated = params.get('catalog') === 'populated';
  const before = params.get('groupBefore');
  const cursor = (before || params.get('groupAfter') || '').replaceAll('\0', '').slice(0, 512);
  const comparison = before ? '<' : '>';
  const order = before ? 'DESC' : 'ASC';
  const { rows } = await db.query(`
    SELECT id, name, article_count, active
    FROM usenet_groups
    WHERE source = $1
      AND (active OR article_count > 0)
      AND (NOT $5::boolean OR article_count > 0)
      AND ($2 = '' OR strpos(lower(name), lower($2)) > 0)
      AND ($3 = '' OR name ${comparison} $3)
    ORDER BY name ${order}
    LIMIT $4
  `, [host, filter, cursor, pageSize + 1, populated]);
  return { ...paginate(rows, Boolean(before), cursor), filter, populated };
}

async function readArticles(db, group, params, filters, threadKey) {
  const before = articleNumber(params.get('articleBefore'));
  const cursor = before ?? articleNumber(params.get('articleAfter'));
  const ascending = Boolean(before) !== (filters.direction === 'asc');
  const comparison = ascending ? '>' : '<';
  const order = ascending ? 'ASC' : 'DESC';
  const value = articleColumns[filters.sort].value;
  const { rows } = await db.query(`
    WITH pivot AS (
      SELECT ${value} AS sort_value, number FROM usenet_articles WHERE group_id = $1 AND number = $2
    )
    SELECT number, subject, author, posted_at, message_id, thread_key
    FROM usenet_articles
    WHERE group_id = $1
      AND ($2::bigint IS NULL OR NOT EXISTS (SELECT 1 FROM pivot)
        OR (${value}, number) ${comparison} (SELECT sort_value, number FROM pivot))
      AND ($4::text = '' OR strpos(lower(subject), lower($4)) > 0 OR strpos(lower(author), lower($4)) > 0)
      AND ($5::text IS NULL OR thread_key = $5)
    ORDER BY ${value} ${order}, number ${order}
    LIMIT $3
  `, [group.id, cursor?.toString() ?? null, pageSize + 1, filters.search, threadKey]);
  return paginate(rows, Boolean(before), cursor);
}

async function readArticle(db, groupId, number, sourceMode) {
  const { rows: [article] } = await db.query(`
    SELECT number, message_id, subject, author, posted_at, body, thread_key,
      CASE WHEN $3::boolean THEN source_text END AS source_text
    FROM usenet_articles WHERE group_id = $1 AND number = $2
  `, [groupId, number, sourceMode]);
  return article;
}

async function readArchive(db, host, params) {
  const groupId = params.has('group') ? articleNumber(params.get('group')) : null;
  const number = params.has('article') ? articleNumber(params.get('article')) : null;
  if ((params.has('group') && !groupId) || (params.has('article') && (!groupId || !number))) return null;

  const [groups, { rows: [summary] }, { rows: [group] }] = await Promise.all([
    readGroups(db, host, params),
    db.query(`
      SELECT count(*) FILTER (WHERE active OR article_count > 0) AS groups,
        coalesce(sum(article_count), 0) AS articles, max(synced_at) AS latest_sync
      FROM usenet_groups WHERE source = $1
    `, [host]),
    groupId ? db.query(`
      SELECT id, name, article_count, active FROM usenet_groups WHERE source = $1 AND id = $2
    `, [host, groupId.toString()]) : db.query(`
      SELECT id, name, article_count, active FROM usenet_groups
      WHERE source = $1 AND article_count > 0 ORDER BY article_count DESC, name LIMIT 1
    `, [host]),
  ]);
  if (groupId && !group) return null;
  const page = { host, groups, summary, group, params, explicitArticle: Boolean(number) };
  if (!group) return page;

  const filters = articleFilters(params);
  const threadNumber = articleNumber(params.get('thread'));
  const sourceMode = params.get('view') === 'source';
  let article = number ? await readArticle(db, group.id, number.toString(), sourceMode) : null;
  if (number && !article) return null;
  const thread = threadNumber && (number === threadNumber
    ? article : await readArticle(db, group.id, threadNumber.toString(), false));
  const articles = await readArticles(db, group, params, filters, thread?.thread_key ?? null);
  if (!number && articles.items.length) {
    article = await readArticle(db, group.id, articles.items[0].number, sourceMode);
  }
  return { ...page, filters, articles, article, thread: thread?.thread_key ? thread : null };
}

function send(request, response, status, contentType, content, headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

async function main() {
  const config = webConfig();
  const db = openDatabase(config.databaseUrl);
  try {
    await initializeDatabase(db);
    const files = [
      ['archive.css', 'text/css; charset=utf-8'],
      ['reader.js', 'text/javascript; charset=utf-8'],
      ['site-logo.png', 'image/png'],
      ['favicon.png', 'image/png'],
    ];
    const assets = new Map(await Promise.all(files.map(async ([name, contentType]) => {
      const content = await readFile(new URL('../public/' + name, import.meta.url));
      return ['/' + name, { contentType, content }];
    })));
    const server = createServer(async (request, response) => {
      const html = (status, page, headers) => send(request, response, status, 'text/html; charset=utf-8', page, headers);
      try {
        if (!['GET', 'HEAD'].includes(request.method)) {
          return html(405, errorPage('只读访问', '此站点提供新闻组与文章浏览。'), { Allow: 'GET, HEAD' });
        }
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/healthz') {
          await db.query('SELECT 1');
          return send(request, response, 200, 'text/plain; charset=utf-8', 'ok\n', { 'Cache-Control': 'no-store' });
        }
        const asset = assets.get(url.pathname);
        if (asset) {
          return send(request, response, 200, asset.contentType, asset.content, { 'Cache-Control': 'no-cache' });
        }
        if (url.pathname === '/') {
          const page = await readArchive(db, config.host, url.searchParams);
          if (page) return html(200, archivePage(page));
        }
        return html(404, errorPage('找不到页面', '此链接可能指向尚未同步的内容。'));
      } catch (error) {
        console.error(error);
        return html(500, errorPage('暂时无法读取归档', '请稍后重试。'));
      }
    });
    server.listen(config.webPort, config.webHost);
    await once(server, 'listening');
    const host = config.webHost.includes(':') ? `[${config.webHost}]` : config.webHost;
    console.log(`CNUsenet 已启动 · http://${host}:${config.webPort}`);
    const stop = () => server.close(() => { void db.end(); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await db.end();
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
