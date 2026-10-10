'use client';
import { useState } from 'react';
import type { Config } from '@/lib/types';

const inputClass = 'w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700';

export function DirectConnectionsSettings({ config }: { config: Config | null }) {
  const [status, setStatus] = useState('');
  const [testing, setTesting] = useState(false);
  async function testConnection(target: string, button: HTMLButtonElement) {
    if (!button.form) return;
    const data = new FormData(button.form);
    const settings = target === 'architect' ? { url: data.get('architect_url') } : {
      baseUrl: data.get('lumiverse_baseUrl'), sessionToken: data.get('lumiverse_sessionToken'), sessionCookie: data.get('lumiverse_sessionCookie'),
    };
    setTesting(true);
    try {
      const response = await fetch('/api/config/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, settings }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Connection failed');
      setStatus('Connected successfully. Save Settings to keep this connection.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Connection failed'); }
    finally { setTesting(false); }
  }
  return <div className="space-y-6">
    <section className="space-y-3">
      <h3 className="font-semibold">Character Architect</h3>
      <label className="block">Instance URL<input className={inputClass} name="architect_url" type="url" defaultValue={config?.characterArchitect?.url || ''} placeholder="https://architect.example.com" /></label>
      <p className="text-sm text-slate-500">Use the Architect address reachable from Archive. Starring a card sends it to Architect automatically. Stars and unstars then sync every 15 seconds, with retries when either app comes back online.</p>
      <button className="rounded border px-3 py-2" type="button" disabled={testing} onClick={e => testConnection('architect', e.currentTarget)}>Test Architect connection</button>
    </section>
    <section className="space-y-3">
      <h3 className="font-semibold">Lumiverse</h3>
      <label className="flex gap-2"><input type="checkbox" name="lumiverse_enabled" defaultChecked={config?.lumiverse?.enabled || false} />Enable sending cards to Lumiverse</label>
      <label className="block">Instance URL<input className={inputClass} name="lumiverse_baseUrl" type="url" defaultValue={config?.lumiverse?.baseUrl || ''} placeholder="http://localhost:7860" /></label>
      <label className="block">Session token<input className={inputClass} name="lumiverse_sessionToken" type="password" autoComplete="off" defaultValue={config?.lumiverse?.sessionToken || ''} /></label>
      <label className="block">Session cookie<input className={inputClass} name="lumiverse_sessionCookie" type="password" autoComplete="off" defaultValue={config?.lumiverse?.sessionCookie || ''} /></label>
      <p className="text-sm text-slate-500">For a signed-in instance, copy its session cookie from your browser’s developer tools, or use a session bearer token. Leave both blank for passwordless LAN mode. Replace expired credentials here.</p>
      <button className="rounded border px-3 py-2" type="button" disabled={testing} onClick={e => testConnection('lumiverse', e.currentTarget)}>Test Lumiverse connection</button>
    </section>
    <section className="space-y-3">
      <h3 className="font-semibold">Favorites</h3>
      <p className="text-sm text-slate-500">Favorites always save in Archive. New stars send cards to your configured Architect instance without a Chub account. Removing a star keeps the card in both apps.</p>
      <label className="flex gap-2"><input type="checkbox" name="syncFavoritesToChub" defaultChecked={config?.syncFavoritesToChub === true} />Also sync favorite changes to Chub</label>
    </section>
    {status && <p role="status">{status}</p>}
  </div>;
}
