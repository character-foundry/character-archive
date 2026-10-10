'use client';

import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { X, Loader2, Check, AlertCircle, RefreshCw, Server, Cloud, Globe } from 'lucide-react';
import clsx from 'clsx';
import { useFederation } from '../hooks/useFederation';
import type { FederationPlatform } from '@/lib/types';

interface FederationModalProps {
  show: boolean;
  onClose: () => void;
  onOpenConnections: () => void;
}

const PLATFORM_ICONS: Record<string, typeof Cloud> = {
  sillytavern: Cloud,
  hub: Globe,
};

const PLATFORM_COLORS: Record<string, { bg: string; border: string; text: string; ring: string }> = {
  sillytavern: {
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'focus:ring-emerald-200',
  },
  hub: {
    bg: 'bg-purple-50 dark:bg-purple-900/20',
    border: 'border-purple-200 dark:border-purple-800',
    text: 'text-purple-600 dark:text-purple-400',
    ring: 'focus:ring-purple-200',
  },
};

const PLATFORM_PLACEHOLDERS: Record<string, string> = {
  sillytavern: 'http://localhost:8000',
  hub: 'https://cardshub.example.com',
};

export function FederationModal({ show, onClose, onOpenConnections }: FederationModalProps) {
  const {
    platforms,
    loading,
    error,
    loadPlatforms,
    updatePlatform,
    testConnection,
    connectionStatus,
  } = useFederation();

  const [formData, setFormData] = useState<Record<string, { base_url: string; api_key: string; enabled: boolean }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ platform: string; type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (show) {
      loadPlatforms();
    }
  }, [show, loadPlatforms]);

  useEffect(() => {
    // Initialize form data from platforms
    const data: typeof formData = {};
    platforms.forEach(p => {
      data[p.platform] = {
        base_url: p.base_url || '',
        api_key: '',
        enabled: Boolean(p.enabled),
      };
    });
    setFormData(data);
  }, [platforms]);

  const handleTest = async (platform: string) => {
    setTesting(platform);
    try {
      await testConnection(platform);
    } finally {
      setTesting(null);
    }
  };

  const handleSave = async (platform: string) => {
    const data = formData[platform];
    if (!data) return;

    setSaving(platform);
    setSaveStatus(null);

    try {
      await updatePlatform(platform, {
        base_url: data.base_url || undefined,
        api_key: data.api_key || undefined,
        enabled: data.enabled,
      });
      setSaveStatus({ platform, type: 'success', message: 'Saved!' });
      // Reload to get fresh data
      await loadPlatforms();
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus({
        platform,
        type: 'error',
        message: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      setSaving(null);
    }
  };

  const renderPlatformCard = (platform: FederationPlatform) => {
    const Icon = PLATFORM_ICONS[platform.platform] || Cloud;
    const colors = PLATFORM_COLORS[platform.platform] || PLATFORM_COLORS.hub;
    const data = formData[platform.platform] || { base_url: '', api_key: '', enabled: false };
    const status = connectionStatus[platform.platform];
    const isTesting = testing === platform.platform;
    const isSaving = saving === platform.platform;
    const platformSaveStatus = saveStatus?.platform === platform.platform ? saveStatus : null;

    return (
      <div
        key={platform.platform}
        className={clsx(
          'rounded-2xl border p-4 transition-all',
          data.enabled
            ? `${colors.border} ${colors.bg}`
            : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
        )}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className={clsx(
              'rounded-xl p-2',
              data.enabled
                ? `${colors.bg} ${colors.text}`
                : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
            )}>
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white">
                {platform.display_name}
              </h3>
              {platform.last_connected_at && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Last connected: {new Date(platform.last_connected_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(e) => setFormData(prev => ({
                ...prev,
                [platform.platform]: { ...data, enabled: e.target.checked },
              }))}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
            />
            <span className="text-sm text-slate-600 dark:text-slate-300">Enabled</span>
          </label>
        </div>

        {/* Connection Status */}
        {status && (
          <div className={clsx(
            'flex items-center gap-2 text-sm mb-3 px-3 py-2 rounded-lg',
            status.connected
              ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          )}>
            {status.connected ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            {status.connected ? 'Connected' : status.error || 'Connection failed'}
          </div>
        )}

        {/* Form Fields */}
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-300">Base URL</span>
            <input
              type="text"
              value={data.base_url}
              onChange={(e) => setFormData(prev => ({
                ...prev,
                [platform.platform]: { ...data, base_url: e.target.value },
              }))}
              placeholder={PLATFORM_PLACEHOLDERS[platform.platform] || 'https://...'}
              className={clsx(
                'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm',
                'focus:border-indigo-400 focus:outline-none focus:ring-2',
                colors.ring,
                'dark:border-slate-600 dark:bg-slate-700 dark:text-white'
              )}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              API Key {platform.api_key && <span className="text-slate-400">(configured)</span>}
            </span>
            <input
              type="password"
              value={data.api_key}
              onChange={(e) => setFormData(prev => ({
                ...prev,
                [platform.platform]: { ...data, api_key: e.target.value },
              }))}
              placeholder="Leave blank to keep existing"
              className={clsx(
                'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm',
                'focus:border-indigo-400 focus:outline-none focus:ring-2',
                colors.ring,
                'dark:border-slate-600 dark:bg-slate-700 dark:text-white'
              )}
            />
          </label>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
          <button
            onClick={() => handleTest(platform.platform)}
            disabled={isTesting || !data.base_url}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:text-white transition-colors"
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Test Connection
          </button>

          <div className="flex items-center gap-2">
            {platformSaveStatus && (
              <span className={clsx(
                'text-sm',
                platformSaveStatus.type === 'success' ? 'text-green-600' : 'text-red-600'
              )}>
                {platformSaveStatus.message}
              </span>
            )}
            <button
              onClick={() => handleSave(platform.platform)}
              disabled={isSaving}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Transition.Root show={show} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-50">
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel className="relative w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
                <Dialog.Title className="text-xl font-bold text-slate-900 dark:text-white">
                  Federation Settings
                </Dialog.Title>
                <button
                  onClick={onClose}
                  className="rounded-full p-2 text-slate-500 hover:bg-slate-100 transition dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="overflow-y-auto max-h-[calc(90vh-8rem)] px-6 py-6">
                {error && (
                  <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
                    {error}
                  </div>
                )}

                <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
                  Configure platforms that use federation to receive cards from Archive.
                </p>

                <section className="mb-6 space-y-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
                  <h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><Server className="h-5 w-5" />Character Architect</h3>
                  <p className="text-sm text-slate-600 dark:text-slate-400">Sending cards to Architect and syncing their favorites use the instance URL in Connections &amp; favorites.</p>
                  <button onClick={onOpenConnections} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Open Connections &amp; favorites</button>
                </section>

                {loading && platforms.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {platforms.filter(platform => platform.platform !== 'architect').map(renderPlatformCard)}
                  </div>
                )}

                {platforms.length > 0 && (
                  <div className="mt-6 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                    <h4 className="font-medium text-slate-700 dark:text-slate-300 mb-2">Quick Tips</h4>
                    <ul className="text-sm text-slate-600 dark:text-slate-400 space-y-1">
                      <li>• <strong>SillyTavern:</strong> Requires the CForge plugin installed</li>
                      <li>• <strong>CardsHub:</strong> Coming soon - public card sharing</li>
                    </ul>
                  </div>
                )}
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
