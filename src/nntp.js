import { createConnection } from 'node:net';
import { articleNumber } from './config.js';

const crlf = Buffer.from('\r\n');

export class NntpError extends Error {
  constructor(command, response) {
    super(`NNTP ${command}: ${response.line}`);
    this.code = response.code;
  }
}

export class NntpClient {
  constructor({ host, timeoutMs, maxArticleBytes }) {
    this.socket = createConnection({ host, port: 119 });
    this.socket.setTimeout(timeoutMs, () => this.socket.destroy(new Error('NNTP 连接超时')));
    this.input = this.socket[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.maxArticleBytes = maxArticleBytes;
  }

  async ready() {
    this.expect('连接', await this.response(), [200, 201]);
    const mode = await this.command('MODE READER');
    this.expect('MODE READER', mode, [200, 201, 500, 501]);
  }

  close() {
    this.socket.destroy();
  }

  async readLine(limit) {
    const fragments = [];
    let length = 0;
    while (true) {
      const end = this.chunk.indexOf(10);
      const fragment = end === -1 ? this.chunk : this.chunk.subarray(0, end);
      length += fragment.length;
      if (length > limit) throw new Error(`NNTP 单行超过 ${limit} 字节`);
      if (fragment.length) fragments.push(fragment);

      if (end !== -1) {
        this.chunk = this.chunk.subarray(end + 1);
        const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, length);
        return line.at(-1) === 13 ? line.subarray(0, -1) : line;
      }

      const { value, done } = await this.input.next();
      if (done) throw new Error('NNTP 连接提前关闭');
      this.chunk = value;
    }
  }

  async response() {
    const line = (await this.readLine(8192)).toString('utf8');
    const match = /^(\d{3})(?: |$)/.exec(line);
    if (!match) throw new Error('NNTP 返回了无法识别的响应');
    return { code: Number(match[1]), line };
  }

  async command(command) {
    this.socket.write(`${command}\r\n`);
    return this.response();
  }

  expect(command, response, codes) {
    if (!codes.includes(response.code)) throw new NntpError(command, response);
  }

  async *dataLines(limit = 8192) {
    while (true) {
      const line = await this.readLine(limit);
      if (line[0] === 46) {
        if (line.length === 1) return;
        yield line.subarray(1);
      } else {
        yield line;
      }
    }
  }

  async *listGroups() {
    let response = await this.command('LIST ACTIVE');
    if ([500, 501].includes(response.code)) response = await this.command('LIST');
    this.expect('LIST ACTIVE', response, [215]);
    for await (const line of this.dataLines()) {
      const [name, high, low, status] = line.toString('utf8').trim().split(/\s+/, 4);
      if (!name || !status || articleNumber(high) === null || articleNumber(low) === null) {
        throw new Error('NNTP 返回了无效的新闻组记录');
      }
      yield { name, high, low, status };
    }
  }

  async selectGroup(name) {
    const response = await this.command(`GROUP ${name}`);
    this.expect('GROUP', response, [211]);
    const [, , first, last] = response.line.split(/ +/);
    const low = articleNumber(first);
    const high = articleNumber(last);
    if (low === null || high === null) throw new Error('NNTP 返回了无效的文章编号范围');
    return { low, high };
  }

  async listNumbers(name, start, end) {
    const response = await this.command(`LISTGROUP ${name} ${start}-${end}`);
    if ([500, 501].includes(response.code)) return null;
    this.expect('LISTGROUP', response, [211]);
    const numbers = new Set();
    for await (const line of this.dataLines()) {
      const number = articleNumber(line.toString('ascii'));
      if (number === null) throw new Error('LISTGROUP 返回了无效的文章编号');
      if (number >= start && number <= end) numbers.add(number);
    }
    return [...numbers].sort((left, right) => left < right ? -1 : 1);
  }

  async fetchArticle(number) {
    const response = await this.command(`ARTICLE ${number}`);
    if (response.code === 423) return null;
    this.expect('ARTICLE', response, [220]);
    const [, returned, messageId = ''] = response.line.split(/ +/);
    if (articleNumber(returned) !== number) throw new Error('ARTICLE 返回了不同的文章编号');

    const fragments = [];
    let length = 0;
    for await (const line of this.dataLines(this.maxArticleBytes + 2)) {
      length += line.length + crlf.length;
      if (length > this.maxArticleBytes) throw new Error(`文章 #${number} 超过 NNTP_MAX_ARTICLE_BYTES`);
      fragments.push(line, crlf);
    }
    return { raw: Buffer.concat(fragments, length), messageId };
  }
}
