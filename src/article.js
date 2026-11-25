import { isUtf8 } from 'node:buffer';
import { simpleParser } from 'mailparser';

const replacementBytes = Buffer.from('�');
const han = /\p{Script=Han}/u;
const charsetParameter = /(;[ \t\r\n]*charset[ \t\r\n]*=[ \t\r\n]*)(?:"([^"]*)"|([^;\s]+))/i;
const chineseCharset = /^(?:gbk|gb\d+|gb_2312-80|x-gbk|cp936|big5(?:-hkscs)?|cn-big5)$/i;
const asciiCharset = /^(?:us-)?ascii$/i;

function articleParts(raw) {
  let end = raw.indexOf('\r\n\r\n');
  let separatorLength = 4;
  const lfEnd = raw.indexOf('\n\n');
  if (lfEnd >= 0 && (end < 0 || lfEnd < end)) {
    end = lfEnd;
    separatorLength = 2;
  }
  if (end < 0) return null;

  const headers = raw.subarray(0, end).toString('latin1');
  const type = /^content-type:([^\r\n]*(?:\r?\n[\t ][^\r\n]*)*)/im.exec(headers)?.[1] ?? '';
  const charsetMatch = charsetParameter.exec(type);
  const charset = (charsetMatch?.[2] ?? charsetMatch?.[3] ?? '').trim().toLowerCase();
  const transfer = /^content-transfer-encoding:[\t ]*([\w-]+)/im.exec(headers)?.[1].toLowerCase();
  return {
    headers, type, charset,
    mediaType: type.split(';', 1)[0].trim().toLowerCase() || 'text/plain',
    unencoded: !transfer || ['7bit', '8bit', 'binary'].includes(transfer),
    separator: raw.subarray(end, end + separatorLength),
    body: raw.subarray(end + separatorLength),
  };
}

function textDecoder(charset) {
  try {
    return new TextDecoder(charset);
  } catch {
    return null;
  }
}

function decodeLegacy(bytes, charset) {
  const decoder = textDecoder(charset);
  if (!decoder) return null;
  if (!chineseCharset.test(charset) || !bytes.includes(replacementBytes)) return decoder.decode(bytes);
  // These old posts already contain UTF-8 replacement markers mixed with legacy bytes.
  return bytes.toString('latin1').split(replacementBytes.toString('latin1'))
    .map(part => decoder.decode(Buffer.from(part, 'latin1'))).join('�');
}

function normalizedHeaders({ headers, charset }) {
  return headers.replace(/^(subject|from):([^\r\n]*(?:\r?\n[\t ][^\r\n]*)*)/gim, (field, name, value) => {
    if (value.includes('=?')) return field;
    const bytes = Buffer.from(value, 'latin1');
    const validUtf8 = isUtf8(bytes);
    const declaredChinese = chineseCharset.test(charset);
    if (validUtf8 && (han.test(bytes.toString('utf8')) || (!declaredChinese && !bytes.includes(replacementBytes)))) {
      return field;
    }

    const declared = !validUtf8 || declaredChinese ? decodeLegacy(bytes, charset) : null;
    const fallback = decodeLegacy(bytes, 'gb18030');
    const decoded = declared && (declaredChinese || (!validUtf8 && !/^(?:utf-?8|(?:us-)?ascii)$/i.test(charset)))
      ? declared
      : han.test(fallback) ? fallback : null;
    if (!decoded || (validUtf8 && !han.test(decoded))) return field;
    return name + ':' + Buffer.from(decoded).toString('latin1');
  });
}

function inferredChinese(bytes) {
  if (isUtf8(bytes)) return null;
  const guess = decodeLegacy(bytes, 'gb18030');
  const remaining = guess?.replaceAll('�', '') ?? '';
  const existingMarkers = bytes.toString('latin1').split(replacementBytes.toString('latin1')).length - 1;
  return han.test(remaining) && guess.length - remaining.length <= existingMarkers ? guess : null;
}

function readableBody(parts) {
  if (!parts.unencoded || !parts.mediaType.startsWith('text/')) return null;

  const { body, charset } = parts;
  if (!charset || asciiCharset.test(charset)) return inferredChinese(body);
  if (chineseCharset.test(charset) && body.includes(replacementBytes)) {
    return decodeLegacy(body, charset);
  }
  return null;
}

export function parseArticle(raw) {
  const parts = articleParts(raw);
  const options = { skipTextToHtml: true, skipImageLinks: true };
  if (!parts) return simpleParser(raw, options);

  const headers = normalizedHeaders(parts);
  const text = readableBody(parts);
  if (text === null && headers === parts.headers) return simpleParser(raw, options);

  let normalized = headers;
  if (text !== null) {
    normalized = parts.charset
      ? headers.replace(/^content-type:[^\r\n]*(?:\r?\n[\t ][^\r\n]*)*/im, type => type.replace(charsetParameter, '$1utf-8'))
      : headers + (parts.type ? '' : '\r\nContent-Type: text/plain; charset=utf-8');
  }
  return simpleParser(Buffer.concat([
    Buffer.from(normalized, 'latin1'), parts.separator, text === null ? parts.body : Buffer.from(text),
  ]), options);
}

export function decodeArticleSource(raw) {
  const parts = articleParts(raw);
  if (!parts) return raw.toString('utf8');
  const headers = Buffer.from(normalizedHeaders(parts), 'latin1').toString('utf8');
  if (!parts.unencoded || !parts.mediaType.startsWith('text/')) {
    return headers + parts.separator.toString('ascii') + parts.body.toString('utf8');
  }
  const text = !parts.charset || asciiCharset.test(parts.charset)
    ? inferredChinese(parts.body) : decodeLegacy(parts.body, parts.charset);
  return headers + parts.separator.toString('ascii') + (text ?? parts.body.toString('utf8'));
}

export const articleDecodeVersion = 1;

export async function decodeArticleFields(raw) {
  const mail = await parseArticle(raw);
  const dbText = value => (value || '').replaceAll('\0', '�');
  return {
    subject: dbText(mail.subject),
    author: dbText(mail.from?.text),
    body: dbText(mail.text),
    messageId: dbText(mail.messageId),
    postedAt: Number.isFinite(mail.date?.getTime()) ? mail.date : null,
  };
}

export function discussionKey(raw, messageId) {
  const end = raw.indexOf('\r\n\r\n');
  const headers = raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
  const unfolded = headers.replace(/\r\n[\t ]+/g, ' ');
  for (const name of ['references', 'in-reply-to']) {
    const field = unfolded.split('\r\n').find(line => line.toLowerCase().startsWith(name + ':'));
    const reference = field?.match(/<[!-;=?-~]+>/)?.[0];
    if (reference) return reference;
  }
  return messageId || null;
}
