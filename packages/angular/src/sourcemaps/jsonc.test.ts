import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a":[1,2,{"b":null}]}')).toEqual({ a: [1, 2, { b: null }] });
  });

  it('ignores line and block comments, as angular.json allows', () => {
    const text = `{
      // the project
      "a": 1, /* inline */ "b": 2
      /* trailing
         block */
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  it('leaves comment-looking text inside a string alone, including an escaped quote before it', () => {
    expect(parseJsonc('{"url":"http://x/*y*/","q":"a\\"//b"}')).toEqual({
      url: 'http://x/*y*/',
      q: 'a"//b',
    });
  });

  it('accepts trailing commas', () => {
    expect(parseJsonc('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('keeps a comma that is followed by a value, and one inside a string', () => {
    expect(parseJsonc('{"a":"x,]","b":[1,2]}')).toEqual({ a: 'x,]', b: [1, 2] });
  });

  it('strips a byte-order mark', () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it('throws on text that is not JSON once the comments are gone', () => {
    expect(() => parseJsonc('{"a":')).toThrow();
  });

  it('treats an unterminated block comment as running to the end', () => {
    expect(parseJsonc('{"a":1} /* never closed')).toEqual({ a: 1 });
  });
});
