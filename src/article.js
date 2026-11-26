import { isUtf8 } from 'node:buffer';
import { simpleParser } from 'mailparser';

const replacementChar = '\uFFFD';
const replacementBytes = Buffer.from(replacementChar);
const han = /\p{Script=Han}/u;
const hanGlobal = /\p{Script=Han}/gu;
const badDecoded = /[\uFFFD\uE000-\uF8FF\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/gu;
const commonChinese = /[的了是在有我和你这那不人个上们到说为以要会可也对生能而子得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日问台湾请教引述铭言※《》：，。？！]/gu;
const charsetParameter = /(;[ \t\r\n]*charset[ \t\r\n]*=[ \t\r\n]*)(?:"([^"]*)"|([^;\s]+))/i;
const gbCharset = /^(?:gbk|gb\d+|gb_2312-80|x-gbk|cp936|cn-gb|euc-?cn|gb|x-mac-simp-chinese)$/i;
const big5Charset = /^(?:big5(?:-hkscs)?|cn-big5|cp950|x-x-big5)$/i;
const hzCharset = /^hz-gb-2312$/i;
const iso2022CnCharset = /^iso-2022-cn$/i;
const chineseCharset = /^(?:gbk|gb\d+|gb_2312-80|x-gbk|cp936|cn-gb|euc-?cn|gb|x-mac-simp-chinese|big5(?:-hkscs)?|cn-big5|cp950|x-x-big5|hz-gb-2312|iso-2022-cn)$/i;
const asciiCharset = /^(?:us-)?ascii$/i;
const utf8Charset = /^utf-?8$/i;
const latin1Charset = /^(?:iso-8859-1|latin-?1|windows-1252|cp1252|x-user-defined|3dw(?:indow=)?)$/i;
const strictGb18030 = new TextDecoder('gb18030', { fatal: true });

function cleanCharset(rawCharset) {
  const trimmed = (rawCharset ?? '').trim().toLowerCase().replace(/^3d(?=[a-z])/, '').replace(/^["'\\,;]+|["'\\,;]+$/g, '');
  if (/^3dw(?:indow=)?$/.test(trimmed)) return 'windows-1252';
  return trimmed;
}

function chineseScore(text) {
  if (!text) return -Infinity;
  const hanCount = text.match(hanGlobal)?.length ?? 0;
  const commonCount = text.match(commonChinese)?.length ?? 0;
  const badCount = text.match(badDecoded)?.length ?? 0;
  return commonCount * 2 + hanCount - badCount * 4;
}

function resolveCharset(charset, headers, body) {
  if (!big5Charset.test(charset)) return charset;
  const sample = /[\x80-\xff]/.test(body.subarray(0, 4096).toString('latin1'))
    ? body.subarray(0, 4096)
    : Buffer.from(headers, 'latin1');
  if (!/[\x80-\xff]/.test(sample.toString('latin1'))) return charset;
  if (isUtf8(sample) && !sample.includes(replacementBytes)) return charset;
  const asBig5 = decodeLegacy(sample, 'big5');
  const asGb = decodeLegacy(sample, 'gb18030');
  return chineseScore(asGb) > chineseScore(asBig5) ? 'gb18030' : charset;
}

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
  const rawCharset = cleanCharset(charsetMatch?.[2] ?? charsetMatch?.[3] ?? '');
  const body = raw.subarray(end + separatorLength);
  const charset = resolveCharset(rawCharset, headers, body);
  const transfer = /^content-transfer-encoding:[\t ]*([\w-]+)/im.exec(headers)?.[1].toLowerCase();
  const parts = {
    headers, type, rawCharset, charset,
    mediaType: type.split(';', 1)[0].trim().toLowerCase() || 'text/plain',
    unencoded: !transfer || ['7bit', '8bit', 'binary'].includes(transfer),
    separator: raw.subarray(end, end + separatorLength),
    body,
  };
  parts.normalizedHeaders = normalizedHeaders(parts);
  return parts;
}

function textDecoder(charset) {
  const target = gbCharset.test(charset) ? 'gb18030'
    : big5Charset.test(charset) ? 'big5'
      : latin1Charset.test(charset) ? 'windows-1252'
        : charset;
  try {
    return new TextDecoder(target);
  } catch {
    return null;
  }
}

function decodeSevenBitChinese(bytes, charset) {
  const decoder = textDecoder('gb18030');
  const text = bytes.toString('latin1');
  if (hzCharset.test(charset) && text.includes('~{')) {
    return text.replace(/~\r?\n/g, '').replace(/~\{([\x21-\x7e\t ]*?)~\}|~~/g, (match, chunk) => {
      if (match === '~~') return '~';
      const shifted = Buffer.from(chunk, 'latin1').map(byte => byte >= 0x21 && byte <= 0x7e ? byte | 0x80 : byte);
      return decoder.decode(shifted);
    });
  }
  if (iso2022CnCharset.test(charset) && text.includes('\x1b$')) {
    return text.replace(/\x1b\$[()*]*[A-Z]/g, '').replace(/\x0e([\x21-\x7e\t ]*?)(?:\x0f|$)/g, (_, chunk) => {
      const shifted = Buffer.from(chunk, 'latin1').map(byte => byte >= 0x21 && byte <= 0x7e ? byte | 0x80 : byte);
      return decoder.decode(shifted);
    });
  }
  return null;
}

function decodeLegacy(bytes, charset) {
  if (hzCharset.test(charset) || iso2022CnCharset.test(charset)) {
    const sevenBit = decodeSevenBitChinese(bytes, charset);
    if (sevenBit !== null) return sevenBit;
  }
  const decoder = textDecoder(charset);
  if (!decoder) return null;
  if (!chineseCharset.test(charset) || !bytes.includes(replacementBytes)) return decoder.decode(bytes);
  // These old posts already contain UTF-8 replacement markers mixed with legacy bytes.
  const parts = bytes.toString('latin1').split(replacementBytes.toString('latin1'));
  const alignOddRuns = gbCharset.test(charset);
  return parts.map((part, index) => {
    if (!alignOddRuns) return decoder.decode(Buffer.from(part, 'latin1'));
    const hasLeftMarker = index > 0;
    const hasRightMarker = index < parts.length - 1;
    return part.replace(/[\x80-\xff]+/g, (run, offset) => {
      let chunk = Buffer.from(run, 'latin1');
      if (chunk.length % 2 === 1) {
        if (offset === 0 && hasLeftMarker) chunk = chunk.subarray(1);
        else if (offset + run.length === part.length && hasRightMarker) chunk = chunk.subarray(0, -1);
      }
      return chunk.length ? decoder.decode(chunk) : '';
    });
  }).join(replacementChar);
}

function recoverWrappedText(wrapper, minPairs = 4) {
  if (!wrapper || /[^\x00-\xff]/.test(wrapper)) return null;
  // Some imports stored GB bytes as Latin-1 characters, then encoded those characters in UTF-8.
  const highBytes = wrapper.match(/[\x80-\xff]/g)?.length ?? 0;
  const adjacentPairs = wrapper.match(/[\x80-\xff]{2}/g)?.length ?? 0;
  if (adjacentPairs < minPairs || adjacentPairs * 2 < highBytes * 0.8) return null;

  try {
    const decoded = strictGb18030.decode(Buffer.from(wrapper, 'latin1'));
    const hanCount = decoded.match(hanGlobal)?.length ?? 0;
    return hanCount >= minPairs ? decoded : null;
  } catch {
    let failed = false;
    const decoded = wrapper.replace(/[\x80-\xff]+/g, (run, offset) => {
      if (failed) return run;
      const bytes = Buffer.from(run, 'latin1');
      try {
        return strictGb18030.decode(bytes);
      } catch {
        const atEnd = offset + run.length === wrapper.length || /^[\r\n]/.test(wrapper.slice(offset + run.length));
        if (bytes.length >= 3 && bytes.length % 2 === 1 && atEnd) {
          try {
            return strictGb18030.decode(bytes.subarray(0, -1)) + replacementChar;
          } catch {
            // Fall through to mark failed.
          }
        }
        failed = true;
        return run;
      }
    });
    if (failed) return null;
    const hanCount = decoded.match(hanGlobal)?.length ?? 0;
    return hanCount >= minPairs ? decoded : null;
  }
}

function recoverWrappedChinese(bytes, minPairs = 4) {
  if (!isUtf8(bytes)) return null;
  return recoverWrappedText(bytes.toString('utf8'), minPairs);
}

function inferredChinese(bytes) {
  const rawLatin1 = bytes.toString('latin1');
  const markerLatin1 = replacementBytes.toString('latin1');
  const stripped = rawLatin1.replaceAll(markerLatin1, '');
  const highBytes = stripped.match(/[\x80-\xff]/g)?.length ?? 0;
  const adjacentPairs = stripped.match(/[\x80-\xff]{2}/g)?.length ?? 0;
  if (!adjacentPairs || adjacentPairs * 2 < highBytes * 0.6) return null;

  const guess = decodeLegacy(bytes, 'gb18030');
  if (!guess) return null;
  const existingMarkers = rawLatin1.split(markerLatin1).length - 1;
  const totalMarkers = guess.split(replacementChar).length - 1;
  const newMarkers = Math.max(0, totalMarkers - existingMarkers);
  const hanCount = guess.match(hanGlobal)?.length ?? 0;
  return hanCount > 0 && hanCount >= newMarkers * 2 ? guess : null;
}

function decodeTextBytes(bytes, charset, isHeader = false) {
  if (hzCharset.test(charset) || iso2022CnCharset.test(charset)) {
    const sevenBit = decodeSevenBitChinese(bytes, charset);
    if (sevenBit !== null) return sevenBit;
  }

  const wrapped = recoverWrappedChinese(bytes, isHeader ? 1 : 4);
  if (wrapped !== null) return wrapped;

  const validUtf8 = isUtf8(bytes);
  const hasMarkers = bytes.includes(replacementBytes);
  const declaredChinese = chineseCharset.test(charset);

  if (validUtf8) {
    const utf8 = bytes.toString('utf8');
    if (!/[\x80-\uffff]/.test(utf8)) return isHeader ? null : utf8;
    if (han.test(utf8) && !/[\u0080-\u07ff]/.test(utf8) && (!hasMarkers || !declaredChinese || (utf8.match(hanGlobal)?.length ?? 0) >= 2)) {
      return isHeader ? null : utf8;
    }
    if (!declaredChinese && !hasMarkers) {
      if (/[\u0100-\u07ff]/.test(utf8) && !han.test(utf8)) {
        const inferred = inferredChinese(bytes);
        if (inferred !== null) return inferred;
      }
      return isHeader ? null : utf8;
    }
  }

  if (declaredChinese) {
    const decoded = decodeLegacy(bytes, charset);
    if (decoded && (!validUtf8 || han.test(decoded))) return decoded;
  }

  const inferred = inferredChinese(bytes);
  if (inferred !== null) return inferred;

  if (!validUtf8) {
    const fallbackCharset = charset && !asciiCharset.test(charset) && !utf8Charset.test(charset)
      ? charset : 'windows-1252';
    return decodeLegacy(bytes, fallbackCharset);
  }
  return isHeader ? null : bytes.toString('utf8');
}

function normalizedHeaders({ headers, charset }) {
  return headers.replace(/^([!-9;-~]+):([^\r\n]*(?:\r?\n[\t ][^\r\n]*)*)/gm, (field, name, value) => {
    if (name.toLowerCase() === 'content-type') return field;
    if (value.includes('=?') && !/[\x80-\xff]/.test(value)) return field;
    if (!/[\x80-\xff]/.test(value) && !hzCharset.test(charset) && !iso2022CnCharset.test(charset)) return field;
    const bytes = Buffer.from(value, 'latin1');
    const decoded = decodeTextBytes(bytes, charset, true);
    if (!decoded) return field;
    return name + ':' + Buffer.from(decoded).toString('latin1');
  });
}

function readableBody(parts) {
  if (!parts.unencoded) return null;
  if (!parts.mediaType.startsWith('text/')) {
    if (!isUtf8(parts.body) || parts.body.includes(replacementBytes)) {
      return decodeTextBytes(parts.body, parts.charset, false);
    }
    return null;
  }
  return decodeTextBytes(parts.body, parts.charset, false);
}

export async function parseArticle(raw, parts = articleParts(raw)) {
  const options = { skipTextToHtml: true, skipImageLinks: true };
  if (!parts) return simpleParser(raw, options);

  const headers = parts.normalizedHeaders;
  const text = parts.mediaType.startsWith('text/') ? readableBody(parts) : null;

  let normalized = headers;
  if (text !== null) {
    normalized = parts.rawCharset
      ? headers.replace(/^content-type:[^\r\n]*(?:\r?\n[\t ][^\r\n]*)*/im, type => type.replace(charsetParameter, '$1utf-8'))
      : headers + (parts.type ? '' : '\r\nContent-Type: text/plain; charset=utf-8');
  } else if (parts.rawCharset && parts.charset !== parts.rawCharset) {
    normalized = headers.replace(/^content-type:[^\r\n]*(?:\r?\n[\t ][^\r\n]*)*/im, type => type.replace(charsetParameter, `$1${parts.charset}`));
  }

  const input = text === null && normalized === parts.headers
    ? raw
    : Buffer.concat([Buffer.from(normalized, 'latin1'), parts.separator, text === null ? parts.body : Buffer.from(text)]);
  const mail = await simpleParser(input, options);
  if (mail.subject) mail.subject = recoverWrappedText(mail.subject, 1) ?? mail.subject;
  if (mail.from?.text) mail.from.text = recoverWrappedText(mail.from.text, 1) ?? mail.from.text;
  if (mail.text) mail.text = recoverWrappedText(mail.text, 4) ?? mail.text;
  return mail;
}

export function decodeArticleSource(raw, parts = articleParts(raw)) {
  if (!parts) return raw.toString('utf8');
  const headers = Buffer.from(parts.normalizedHeaders, 'latin1').toString('utf8');
  if (!parts.unencoded) {
    return headers + parts.separator.toString('ascii') + parts.body.toString('utf8');
  }
  const text = readableBody(parts);
  return headers + parts.separator.toString('ascii') + (text ?? parts.body.toString('utf8'));
}

export const articleDecodeVersion = 4;

export async function decodeArticleFields(raw) {
  const parts = articleParts(raw);
  const mail = await parseArticle(raw, parts);
  const dbText = value => (value || '').replaceAll('\0', replacementChar);
  return {
    subject: dbText(mail.subject),
    author: dbText(mail.from?.text),
    body: dbText(mail.text),
    sourceText: dbText(decodeArticleSource(raw, parts)),
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
