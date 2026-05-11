import { describe, expect, test } from 'bun:test';
import { browserLoginStartRequest } from '../src/codex.ts';

describe('browserLoginStartRequest', () => {
  test('requests the universal browser login link from Codex app-server', () => {
    expect(browserLoginStartRequest(2)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'account/login/start',
      params: {
        type: 'chatgpt'
      }
    });
  });
});
