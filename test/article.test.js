import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeArticleFields, decodeArticleSource, discussionKey, parseArticle } from '../src/article.js';

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

test('prepares UTF-8 body and source text for storage using the declared GB2312 charset', async () => {
  const headers = 'MIME-Version: 1.0\r\nContent-Type: text/plain;\r\n charset="GB2312"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
  const raw = Buffer.concat([Buffer.from(headers), Buffer.from('d6d0cec4efbfbdb2e2cad4', 'hex')]);
  const fields = await decodeArticleFields(raw);
  assert.equal(fields.sourceText, headers + '中文�测试');
  assert.equal(fields.body, '中文�测试');
});

test('applies MIME transfer decoding in the body while the source keeps the wire representation', async () => {
  for (const [encoding, encoded] of [['base64', '1tDOxA=='], ['quoted-printable', '=D6=D0=CE=C4']]) {
    const headers = 'Content-Type: text/plain; charset=GB2312\r\nContent-Transfer-Encoding: ' + encoding + '\r\n\r\n';
    const raw = Buffer.from(headers + encoded);
    assert.equal(decodeArticleSource(raw), headers + encoded);
    assert.equal((await parseArticle(raw)).text, '中文');
  }
});

test('reads unsigned legacy Chinese and keeps valid UTF-8 under an ASCII declaration', async () => {
  const legacy = Buffer.concat([Buffer.from('Subject: Test\r\n\r\n'), Buffer.from('d6d0cec4', 'hex')]);
  assert.equal((await parseArticle(legacy)).text, '中文');
  assert.match(decodeArticleSource(legacy), /中文$/);
  const utf8 = Buffer.from('Content-Type: text/plain; charset=us-ascii\r\n\r\n中文');
  assert.equal((await parseArticle(utf8)).text, '中文');
  assert.match(decodeArticleSource(utf8), /中文$/);
});

test('recovers GB text wrapped as Latin-1 and preserves genuine Latin-1 posts', async () => {
  const headers = 'Content-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
  const wrapped = Buffer.from('d6d0cec4b2e2cad4', 'hex').toString('latin1');
  const fields = await decodeArticleFields(Buffer.from(headers + wrapped));
  assert.equal(fields.body, '中文测试');
  assert.equal(fields.sourceText, headers + '中文测试');

  const ordinary = Buffer.from(headers + 'Café déjà vu, très bien.', 'latin1');
  assert.equal((await parseArticle(ordinary)).text, 'Café déjà vu, très bien.');
  assert.equal(decodeArticleSource(ordinary), headers + 'Café déjà vu, très bien.');
});

test('uses the first folded reference and falls back to reply and message IDs', () => {
  const headers = Buffer.from('References:\r\n <root@example> <parent@example>\r\nIn-Reply-To: <parent@example>\r\n\r\n');
  assert.equal(discussionKey(headers, '<current@example>'), '<root@example>');
  assert.equal(discussionKey(Buffer.from('In-Reply-To: <parent@example>\r\n\r\n'), '<current@example>'), '<parent@example>');
  assert.equal(discussionKey(Buffer.from('Subject: root\r\n\r\nReferences: <fake@example>'), '<current@example>'), '<current@example>');
});
