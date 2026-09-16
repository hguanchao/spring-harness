import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatSearchOutput,
  isBlockedHost,
  mergeSearchResults,
  parseDdgHtml,
  parseSearchArgs,
  unwrapDdgHref,
  WEB_SEARCH_MAX_QUERIES,
} from './web-search.js';

describe('parseSearchArgs', () => {
  it('dedupes and rejects empty or oversized query lists', () => {
    assert.deepEqual(parseSearchArgs({ queries: ['a', 'a', 'b'] }), ['a', 'b']);
    assert.throws(() => parseSearchArgs({ queries: [] }), /at least one/);
    assert.throws(() => parseSearchArgs({ queries: [' '] }), /non-empty/);
    assert.throws(
      () => parseSearchArgs({ queries: ['a', 'b', 'c', 'd', 'e'] }),
      new RegExp(`at most ${WEB_SEARCH_MAX_QUERIES}`),
    );
  });
});

describe('formatSearchOutput / mergeSearchResults', () => {
  it('round-robins sources, dedupes URLs, and marks truncation', () => {
    const merged = mergeSearchResults(
      ['one', 'two'],
      [
        { sources: [{ url: 'https://a.example', title: 'A' }, { url: 'https://shared.example', title: 'S1' }] , truncated: false },
        { sources: [{ url: 'https://b.example', title: 'B' }, { url: 'https://shared.example', title: 'S2' }] , truncated: false },
      ],
      3,
    );
    assert.deepEqual(
      merged.sources.map((source) => source.url),
      ['https://a.example', 'https://b.example', 'https://shared.example'],
    );
    assert.equal(merged.truncated, false);
  });

  it('labels sources as markdown links and prefixes the untrusted notice', () => {
    const text = formatSearchOutput({
      sources: [{ url: 'https://example.com/x', title: 'Example', snippet: 'hello' }],
      truncated: true,
    });
    assert.ok(text.startsWith('External web content follows.'));
    assert.ok(text.includes('- [Example](https://example.com/x) — hello'));
    assert.ok(text.includes('Refine the query'));
    assert.ok(text.includes('markdown links'));
  });
});

describe('DuckDuckGo HTML parse', () => {
  it('unwraps uddg redirect links and reads title plus snippet', () => {
    const encoded = encodeURIComponent('https://docs.example/page');
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encoded}">Docs &amp; Guide</a>
      <a class="result__snippet">A short <b>blurb</b>.</a>
    `;
    const sources = parseDdgHtml(html);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'https://docs.example/page');
    assert.equal(sources[0].title, 'Docs & Guide');
    assert.equal(sources[0].snippet, 'A short blurb.');
  });

  it('unwrapDdgHref falls back to the raw href', () => {
    assert.equal(unwrapDdgHref('https://example.com/a'), 'https://example.com/a');
  });
});

describe('isBlockedHost', () => {
  it('blocks loopback and RFC1918 hosts', () => {
    assert.equal(isBlockedHost('localhost'), true);
    assert.equal(isBlockedHost('127.0.0.1'), true);
    assert.equal(isBlockedHost('10.0.0.2'), true);
    assert.equal(isBlockedHost('192.168.1.1'), true);
    assert.equal(isBlockedHost('172.16.0.1'), true);
    assert.equal(isBlockedHost('example.com'), false);
    assert.equal(isBlockedHost('::1'), true);
    assert.equal(isBlockedHost('::ffff:127.0.0.1'), true);
    assert.equal(isBlockedHost('fe80::1'), true);
    assert.equal(isBlockedHost('fd12:3456::1'), true);
    assert.equal(isBlockedHost('100.64.1.1'), true);
    assert.equal(isBlockedHost('8.8.8.8'), false);
  });
});
