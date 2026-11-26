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
  assert.equal(decoded.subject, '什么\uFFFD\uFFFD Usenet\uFFFD\uFFFD');
  assert.equal(decoded.text, '中文');
});

test('keeps valid UTF-8 and standard MIME encoded subjects', async () => {
  const utf8 = await parseArticle(Buffer.from('Subject: 测试\uFFFD主题\r\n\r\nbody'));
  assert.equal(utf8.subject, '测试\uFFFD主题');
  const mime = await parseArticle(Buffer.from('Subject: =?GB2312?B?1tDOxA==?=\r\n\r\nbody'));
  assert.equal(mime.subject, '中文');
});

test('prepares UTF-8 body and source text for storage using the declared GB2312 charset', async () => {
  const headers = 'MIME-Version: 1.0\r\nContent-Type: text/plain;\r\n charset="GB2312"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
  const raw = Buffer.concat([Buffer.from(headers), Buffer.from('d6d0cec4efbfbdb2e2cad4', 'hex')]);
  const fields = await decodeArticleFields(raw);
  assert.equal(fields.sourceText, headers + '中文\uFFFD测试');
  assert.equal(fields.body, '中文\uFFFD测试');
});

test('aligns odd-length GB byte runs adjacent to UTF-8 replacement markers', async () => {
  const headers = 'Content-Type: text/plain; charset=GB2312\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
  const raw = Buffer.concat([
    Buffer.from(headers),
    Buffer.from('efbfbde2bcb8efbfbdc3bbcab1efbfbde4a1a3', 'hex'),
  ]);
  const fields = await decodeArticleFields(raw);
  assert.equal(fields.body, '\uFFFD几\uFFFD没时\uFFFD。');
  assert.equal(fields.sourceText, headers + '\uFFFD几\uFFFD没时\uFFFD。');
});

test('applies MIME transfer decoding in the body while the source keeps the wire representation', async () => {
  for (const [encoding, encoded] of [['base64', '1tDOxA=='], ['quoted-printable', '=D6=D0=CE=C4']]) {
    const headers = 'Content-Type: text/plain; charset=GB2312\r\nContent-Transfer-Encoding: ' + encoding + '\r\n\r\n';
    const raw = Buffer.from(headers + encoded);
    assert.equal(decodeArticleSource(raw), headers + encoded);
    assert.equal((await parseArticle(raw)).text, '中文');
  }
});

test('reads unsigned legacy Chinese and keeps valid UTF-8 under an ASCII or GB declaration', async () => {
  const legacy = Buffer.concat([Buffer.from('Subject: Test\r\n\r\n'), Buffer.from('d6d0cec4', 'hex')]);
  assert.equal((await parseArticle(legacy)).text, '中文');
  assert.match(decodeArticleSource(legacy), /中文$/);
  const utf8 = Buffer.from('Content-Type: text/plain; charset=us-ascii\r\n\r\n中文');
  assert.equal((await parseArticle(utf8)).text, '中文');
  assert.match(decodeArticleSource(utf8), /中文$/);
  const utf8UnderGbk = Buffer.from('Content-Type: text/plain; charset=gbk\r\n\r\n当年编码真是问题。。。');
  const fields = await decodeArticleFields(utf8UnderGbk);
  assert.equal(fields.body, '当年编码真是问题。。。');
  assert.match(fields.sourceText, /当年编码真是问题。。。$/);
});

test('recovers GB text wrapped as Latin-1 in bodies, headers, and RFC 2047 words while preserving genuine Latin-1', async () => {
  const headers = 'Content-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
  const wrapped = Buffer.from('d6d0cec4b2e2cad4', 'hex').toString('latin1');
  const fields = await decodeArticleFields(Buffer.from(headers + wrapped));
  assert.equal(fields.body, '中文测试');
  assert.equal(fields.sourceText, headers + '中文测试');

  const rfc2047Wrapped = Buffer.from(
    'Subject: =?iso-8859-1?Q?=B2=E2=CA=D4?=\r\nFrom: =?iso-8859-1?Q?=CC=EC=CD=E2=B7=C9=CF=C9?= <a@example.com>\r\n\r\nok',
  );
  const parsedWrapped = await decodeArticleFields(rfc2047Wrapped);
  assert.equal(parsedWrapped.subject, '测试');
  assert.equal(parsedWrapped.author, '"天外飞仙" <a@example.com>');

  const ordinary = Buffer.from(headers + 'Café déjà vu, très bien.', 'latin1');
  assert.equal((await parseArticle(ordinary)).text, 'Café déjà vu, très bien.');
  assert.equal(decodeArticleSource(ordinary), headers + 'Café déjà vu, très bien.');
});

test('detects gateway-transcoded GB18030 articles carrying a stale Big5 charset and supports cn-gb and iso-2022-cn', async () => {
  const gatewayed = Buffer.concat([
    Buffer.from('Subject: Re: ['),
    Buffer.from('cecacce25d20cca8cde5b5c4ccecc6f8d4a4b1a8', 'hex'),
    Buffer.from('\r\nOrganization: '),
    Buffer.from('c5faccdfccdfcab5d2b5', 'hex'),
    Buffer.from('\r\nContent-Type: text/plain; charset=Big5\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    Buffer.from('cca8cde5b5c4d4a4b1a8b4f3b6e0d7cac1cfb6bccac7c0b4d7d4d6d0d1ebc6f8cff3bed6b0c9', 'hex'),
  ]);
  const gatewayFields = await decodeArticleFields(gatewayed);
  assert.equal(gatewayFields.subject, 'Re: [问题] 台湾的天气预报');
  assert.equal(gatewayFields.body, '台湾的预报大多资料都是来自中央气象局吧');
  assert.match(gatewayFields.sourceText, /Organization: 批踢踢实业/);

  const cnGb = Buffer.concat([
    Buffer.from('Content-Type: text/plain; charset=cn-gb\r\n\r\n'),
    Buffer.from('d6d0cec4b2e2cad4', 'hex'),
  ]);
  assert.equal((await decodeArticleFields(cnGb)).body, '中文测试');

  const iso2022 = Buffer.from('Content-Type: text/plain; charset=iso-2022-cn\r\n\r\n\x1b$)A\x0eVPND2bJT\x0f');
  assert.equal((await decodeArticleFields(iso2022)).body, '中文测试');
});

test('uses the first folded reference and falls back to reply and message IDs', () => {
  const headers = Buffer.from('References:\r\n <root@example> <parent@example>\r\nIn-Reply-To: <parent@example>\r\n\r\n');
  assert.equal(discussionKey(headers, '<current@example>'), '<root@example>');
  assert.equal(discussionKey(Buffer.from('In-Reply-To: <parent@example>\r\n\r\n'), '<current@example>'), '<parent@example>');
  assert.equal(discussionKey(Buffer.from('Subject: root\r\n\r\nReferences: <fake@example>'), '<current@example>'), '<current@example>');
});
