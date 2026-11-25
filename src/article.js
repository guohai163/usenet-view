import { isUtf8 } from 'node:buffer';
import { simpleParser } from 'mailparser';

const legacyChinese = new TextDecoder('gb18030');
const replacementBytes = Buffer.from('�').toString('latin1');
const han = /\p{Script=Han}/u;

function legacyHeaders(raw) {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) return raw;

  const headers = raw.subarray(0, end).toString('latin1');
  const repaired = headers.replace(/^(subject|from):([^\r\n]*(?:\r\n[\t ][^\r\n]*)*)/gim, (field, name, value) => {
    if (value.includes('=?')) return field;
    const bytes = Buffer.from(value, 'latin1');
    if (isUtf8(bytes) && (!value.includes(replacementBytes) || han.test(bytes.toString('utf8')))) return field;
    // Some older archives mix legacy bytes with replacement characters already written as UTF-8.
    const decoded = value.split(replacementBytes)
      .map(part => legacyChinese.decode(Buffer.from(part, 'latin1'))).join('�');
    return han.test(decoded)
      ? `${name}:${Buffer.from(decoded).toString('latin1')}`
      : field;
  });
  return repaired === headers ? raw : Buffer.concat([Buffer.from(repaired, 'latin1'), raw.subarray(end)]);
}

export function parseArticle(raw) {
  return simpleParser(legacyHeaders(raw), { skipTextToHtml: true, skipImageLinks: true });
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
