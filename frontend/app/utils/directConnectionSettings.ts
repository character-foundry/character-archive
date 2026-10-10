import type { Config } from '../../lib/types';

export function readDirectConnectionSettings(data: FormData, previous: Config) {
  const text = (name: string) => String(data.get(name) || '').trim();
  return {
    characterArchitect: { ...previous.characterArchitect, enabled: true, url: text('architect_url') },
    lumiverse: {
      enabled: data.get('lumiverse_enabled') === 'on',
      baseUrl: text('lumiverse_baseUrl'),
      sessionToken: text('lumiverse_sessionToken'),
      sessionCookie: text('lumiverse_sessionCookie'),
    },
    syncFavoritesToChub: data.get('syncFavoritesToChub') === 'on',
  };
}
