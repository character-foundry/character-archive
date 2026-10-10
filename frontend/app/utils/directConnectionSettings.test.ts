import test from 'node:test';
import assert from 'node:assert/strict';
import { readDirectConnectionSettings } from './directConnectionSettings';
import type { Config } from '../../lib/types';

test('Settings saves the Architect URL and enables local-only favorites by default', () => {
  const form = new FormData();
  form.set('architect_url', ' http://architect:3456/ ');
  form.set('lumiverse_enabled', 'on');
  form.set('lumiverse_baseUrl', 'http://lumiverse:7860');
  form.set('lumiverse_sessionCookie', 'session=test');
  const settings = readDirectConnectionSettings(form, {} as Config);
  assert.equal(settings.characterArchitect.url, 'http://architect:3456/');
  assert.equal(settings.lumiverse.sessionCookie, 'session=test');
  assert.equal(settings.lumiverse.enabled, true);
  assert.equal(settings.syncFavoritesToChub, false);
  form.set('syncFavoritesToChub', 'on');
  assert.equal(readDirectConnectionSettings(form, {} as Config).syncFavoritesToChub, true);
});
