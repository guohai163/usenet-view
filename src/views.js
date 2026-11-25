import { decodeArticleSource } from './article.js';
import { articleColumns } from './reading.js';

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const shortDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Shanghai' });
const longDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const formatter = new Intl.NumberFormat('zh-CN');
const resetArticle = { article: null, articleAfter: null, articleBefore: null, view: null };

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

function href(params, changes) {
  const query = new URLSearchParams(params);
  for (const [name, value] of Object.entries(changes)) {
    if (value) query.set(name, value);
    else query.delete(name);
  }
  return escape(query.size ? '/?' + query : '/');
}

function time(value, detailed = false) {
  if (!value) return '—';
  return '<time datetime="' + value.toISOString() + '">' + (detailed ? longDate : shortDate).format(value) + '</time>';
}

function count(value) {
  return formatter.format(BigInt(value));
}

function fields(params, keys) {
  return keys.filter(key => params.get(key))
    .map(key => `<input type="hidden" name="${key}" value="${escape(params.get(key))}">`).join('');
}

function frame(title, content, host) {
  const endpoint = host?.includes(':') ? '[' + host + ']:119' : host + ':119';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#202d43">
  <meta name="robots" content="noindex">
  <title>${escape(title)} · CNUsenet</title>
  <link rel="stylesheet" href="/archive.css">
  <script src="/reader.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">跳到主要内容</a>
  <header class="masthead">
    <a class="brand" href="/" aria-label="CNUsenet 首页">
      <span class="brand-icon" aria-hidden="true"><i></i></span>
      <strong>CNUsenet</strong><span class="brand-label">新闻组阅读器</span>
    </a>
    ${host ? `<div class="endpoint"><span>NNTP</span> ${escape(endpoint)}</div>` : ''}
  </header>
  ${content}
</body>
</html>`;
}

function pager(params, page, before, after, field, label) {
  if (!page.items.length || (!page.previous && !page.next)) return '';
  return `<nav class="pager" aria-label="${label}">
    ${page.previous ? `<a href="${href(params, { [before]: page.items[0][field], [after]: null })}">‹ 上一页</a>` : '<span></span>'}
    ${page.next ? `<a href="${href(params, { [before]: null, [after]: page.items.at(-1)[field] })}">下一页 ›</a>` : ''}
  </nav>`;
}

function directory({ groups, group, params, summary }) {
  const catalogParams = new URLSearchParams(params);
  if (groups.filter) catalogParams.set('q', groups.filter);
  else catalogParams.delete('q');
  const tab = (populated, label) => `<a href="${href(catalogParams, {
    catalog: populated ? 'populated' : null, groupBefore: null, groupAfter: null,
  })}"${groups.populated === populated ? ' aria-current="page"' : ''}>${label}</a>`;
  const rows = groups.items.map(item => `<li><a href="${href(catalogParams, {
    group: item.id, ...resetArticle, find: null, thread: null,
  })}"${group?.id === item.id ? ' aria-current="page"' : ''}>
    <span class="group-icon" aria-hidden="true"></span>
    <span class="group-name" title="${escape(item.name)}">${escape(item.name)}</span>
    <span class="group-count" aria-label="${count(item.article_count)} 篇">${count(item.article_count)}</span>
  </a></li>`).join('');
  return `<aside class="directory" id="directory" aria-labelledby="directory-title">
    <div class="pane-caption"><h2 id="directory-title">新闻组</h2><span class="caption-count">${count(summary.groups)} 个</span></div>
    <nav class="catalog-tabs" aria-label="目录筛选">${tab(false, '全部新闻组')}${tab(true, '有归档文章')}</nav>
    <form class="search" role="search" aria-label="搜索新闻组" action="/" method="get">
      ${fields(params, ['group', 'article', 'view', 'thread', 'find', 'sort', 'order', 'catalog', 'articleBefore', 'articleAfter'])}
      <input type="search" name="q" aria-label="组名" placeholder="查找组名" maxlength="160" value="${escape(groups.filter)}">
      <button type="submit" aria-label="搜索组名"><i class="search-icon" aria-hidden="true"></i></button>
    </form>
    <div class="directory-scroll">
      ${rows ? `<ul class="group-list">${rows}</ul>` : '<p class="empty">没有匹配的新闻组。</p>'}
    </div>
    ${pager(catalogParams, groups, 'groupBefore', 'groupAfter', 'name', '新闻组分页')}
  </aside>`;
}

function rowControls({ group, articles, article, params }) {
  const current = articles.items.findIndex(item => item.number === article?.number);
  const adjacent = (offset, label, key, direction) => {
    const item = current < 0 ? null : articles.items[current + offset];
    if (!item) return `<span class="tool disabled" aria-disabled="true">${direction} ${label}</span>`;
    return `<a class="tool" data-shortcut="${key}" aria-keyshortcuts="${key}" title="${label} (${key})"
      href="${href(params, { group: group.id, article: item.number })}">${direction} ${label}</a>`;
  };
  return `<nav class="row-controls" aria-label="文章导航">
    ${adjacent(-1, '上一篇', 'k', '↑')}${adjacent(1, '下一篇', 'j', '↓')}
  </nav>`;
}

function messageList(page) {
  const { group, articles, article, filters, thread, params } = page;
  if (!group) return '<section class="messages empty-messages"><div class="pane-caption"><h1>文章列表</h1></div><p class="empty">选择新闻组查看归档文章。</p></section>';
  const scoped = new URLSearchParams(params);
  scoped.set('group', group.id);
  const headings = Object.entries(articleColumns).map(([key, column]) => {
    const active = filters.sort === key;
    const direction = active && filters.direction === 'asc' ? 'desc' : active ? 'asc' : column.defaultDirection;
    const ariaSort = active ? (filters.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    const arrow = filters.direction === 'asc' ? '▴' : '▾';
    return `<th class="col-${key}" scope="col" aria-sort="${ariaSort}"><a href="${href(scoped, {
      sort: key, order: direction, ...resetArticle,
    })}">${column.label}${active ? ` <span aria-hidden="true">${arrow}</span>` : ''}</a></th>`;
  }).join('');
  const rows = articles.items.map(item => {
    const selected = item.number === article?.number;
    const reply = item.thread_key && item.thread_key !== item.message_id;
    return `<tr class="message-row${selected ? ' selected' : ''}">
      <td><a class="message-link" data-number="${item.number}" href="${href(scoped, {
        article: item.number,
      })}"${selected ? ' aria-current="true"' : ''} title="${escape(item.subject || '无标题')}">
        <span class="read-dot" aria-hidden="true"></span>
        ${thread && reply ? '<span class="reply-arrow" aria-hidden="true">↳</span>' : ''}
        <span class="subject">${escape(item.subject || '无标题')}</span>
      </a></td>
      <td class="author" title="${escape(item.author)}">${escape(item.author || '—')}</td>
      <td class="date">${time(item.posted_at)}</td>
      <td class="number">${item.number}</td>
    </tr>`;
  }).join('');
  const paging = new URLSearchParams(scoped);
  paging.delete('article');
  paging.delete('view');
  return `<section class="messages" aria-labelledby="group-title">
    <div class="pane-caption list-caption">
      <div><a class="mobile" href="#directory">‹ 新闻组</a><h1 id="group-title">${escape(group.name)}</h1><span class="caption-count">${count(group.article_count)} 篇${group.active ? '' : ' · 已离开来源目录'}</span></div>
      <a class="tool reload" href="${href(scoped, {})}">刷新列表</a>
    </div>
    <div class="list-toolbar">
      ${rowControls(page)}
      <form class="search" role="search" aria-label="搜索组内文章" action="/" method="get">
        ${fields(scoped, ['group', 'q', 'catalog', 'groupBefore', 'groupAfter', 'sort', 'order', 'thread'])}
        <input type="search" name="find" aria-label="主题或作者" placeholder="搜索主题或作者" maxlength="160" value="${escape(filters.search)}">
        <button type="submit" aria-label="搜索文章"><i class="search-icon" aria-hidden="true"></i></button>
      </form>
    </div>
    ${thread ? `<div class="thread-filter">
      <span>讨论串 <strong>${escape(thread.subject || '无标题')}</strong></span>
      <a href="${href(scoped, { thread: null, articleBefore: null, articleAfter: null })}">查看全部 ×</a>
    </div>` : ''}
    <div class="message-scroll">
      <table class="message-table">
        <thead><tr>${headings}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${rows ? '' : '<p class="empty">没有匹配的文章。</p>'}
    </div>
    ${pager(paging, articles, 'articleBefore', 'articleAfter', 'number', '文章分页')}
  </section>`;
}

function reader({ article, explicitArticle, group, params, thread }) {
  if (!article) return '<section class="reader reader-empty"><div class="pane-caption"><h2>阅读</h2></div><p class="empty">选择一篇文章阅读。</p></section>';
  const raw = params.get('view') === 'source';
  const base = { group: group.id, article: article.number };
  const tab = (source, label) => `<a href="${href(params, { ...base, view: source ? 'source' : null })}"${raw === source ? ' aria-current="page"' : ''}>${label}</a>`;
  const content = raw
    ? escape(article.raw ? decodeArticleSource(article.raw) : '')
    : article.body.split(/^([>][^\n]*$)/m).map((piece, index) => index % 2
      ? `<span class="quote">${escape(piece)}</span>` : escape(piece)).join('');
  return `<article class="reader" aria-labelledby="article-title" data-active-number="${article.number}" data-explicit="${explicitArticle}">
    <div class="pane-caption reader-caption">
      <a class="mobile" href="${href(params, { group: group.id, article: null, view: null })}">‹ 文章列表</a>
      <nav class="reader-tabs" aria-label="正文显示">${tab(false, '正文')}${tab(true, '原文')}</nav>
      ${article.thread_key && !thread ? `<a class="tool thread-link" href="${href(params, {
        ...base, thread: article.number, articleBefore: null, articleAfter: null, find: null,
      })}">查看讨论串</a>` : ''}
      <span class="message-id" title="${escape(article.message_id)}">${escape(article.message_id)}</span>
    </div>
    <div class="body-scroll">
      <header class="message-heading">
        <h2 id="article-title">${escape(article.subject || '无标题')}</h2>
        <dl><div><dt>作者</dt><dd>${escape(article.author || '—')}</dd></div>
          <div><dt>日期</dt><dd>${time(article.posted_at, true)}</dd></div></dl>
      </header>
      ${content.trim() ? `<pre class="article-body${raw ? ' raw-body' : ''}">${content}</pre>` : '<p class="empty">此文章暂无可显示的文本。</p>'}
    </div>
  </article>`;
}

export function archivePage(page) {
  const { group, article, explicitArticle, summary, host } = page;
  const title = article?.subject || group?.name || '新闻组归档';
  return frame(title, `
  <div class="layout${explicitArticle ? ' reading' : ''}" data-catalog="${escape(host)}" data-group="${group?.id ?? ''}">
    ${directory(page)}
    <main class="workspace" id="main" tabindex="-1">${messageList(page)}${reader(page)}</main>
  </div>
  <footer class="statusbar">
    <span class="read-only"><i aria-hidden="true"></i> 只读归档</span>
    <span>${count(summary.articles)} 篇文章</span>
    <span class="status-sync">最近同步 ${time(summary.latest_sync, true)}</span>
  </footer>`, host);
}

export function errorPage(title, message) {
  return frame(title, `<main class="error" id="main" tabindex="-1">
    <h1>${escape(title)}</h1><p>${escape(message)}</p><a href="/">返回归档首页</a>
  </main>`);
}
