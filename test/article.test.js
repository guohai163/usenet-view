import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discussionKey, parseArticle } from '../src/article.js';

test('reads legacy GB18030 headers with existing replacement characters and a GB2312 body', async () => {
  const raw = Buffer.concat([
    Buffer.from('Subject: '),
    Buffer.from('cab2c3b4efbfbdefbfbd205573656e6574efbfbdefbfbd', 'hex'),
    Buffer.from('\r\nContent-Type: text/plain; charset=gb2312\r\n\r\n'),
    Buffer.from('d6d0cec4', 'hex'),
  ]);
  const decoded = await parseArticle(raw);
  assert.equal(decoded.subject, '什么�� Usenet��');
  assert.equal(decoded.text, '中文');
});

test('keeps valid UTF-8 and standard MIME encoded subjects', async () => {
  const utf8 = await parseArticle(Buffer.from('Subject: 测试�主题\r\n\r\nbody'));
  assert.equal(utf8.subject, '测试�主题');
  const mime = await parseArticle(Buffer.from('Subject: =?GB2312?B?1tDOxA==?=\r\n\r\nbody'));
  assert.equal(mime.subject, '中文');
});

test('uses the first folded reference and falls back to reply and message IDs', () => {
  const headers = Buffer.from('References:\r\n <root@example> <parent@example>\r\nIn-Reply-To: <parent@example>\r\n\r\n');
  assert.equal(discussionKey(headers, '<current@example>'), '<root@example>');
  assert.equal(discussionKey(Buffer.from('In-Reply-To: <parent@example>\r\n\r\n'), '<current@example>'), '<parent@example>');
  assert.equal(discussionKey(Buffer.from('Subject: root\r\n\r\nReferences: <fake@example>'), '<current@example>'), '<current@example>');
});
