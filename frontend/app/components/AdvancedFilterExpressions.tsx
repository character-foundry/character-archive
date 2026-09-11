import { Disclosure } from '@headlessui/react';
import { ChevronDown, Sparkles } from 'lucide-react';
import clsx from 'clsx';

interface AdvancedFilterExpressionsProps {
  value: string;
  onChange: (value: string) => void;
}

export function AdvancedFilterExpressions({ value, onChange }: AdvancedFilterExpressionsProps) {
  return (
    <Disclosure>
      {({ open }) => (
        <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40">
          <Disclosure.Button className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-500 transition hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100">
            <span className="flex items-center gap-2">
              Advanced filter expressions
              {value.trim() && (
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                  Active
                </span>
              )}
            </span>
            <ChevronDown
              className={clsx('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
            />
          </Disclosure.Button>
          <Disclosure.Panel className="space-y-2 border-t border-slate-200 p-2 dark:border-slate-800">
            <textarea
              aria-label="Advanced filter expressions"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder='source = "chub" AND author = "anonymous" AND tokenCount > 1000'
              rows={3}
              className="block min-h-20 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <Disclosure>
              {({ open }) => (
                <div className="rounded-md border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-xs text-slate-700 shadow-inner dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-slate-300">
                  <Disclosure.Button className="flex w-full items-center justify-between font-semibold">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                      Advanced Search Help
                    </span>
                    <ChevronDown
                      className={clsx('h-4 w-4 transition-transform', open && 'rotate-180')}
                    />
                  </Disclosure.Button>
                  <Disclosure.Panel className="mt-2 space-y-3 text-left break-words">
                    <p>
                      This field accepts text queries such as cute OR funny and field filters such
                      as tags:lightsaber or tokenCount &gt; 1000.
                    </p>
                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">
                        Query String Tips:
                      </p>
                      <ul className="list-disc space-y-1.5 pl-5">
                        <li>
                          Use quotes for exact phrases:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            &quot;space opera&quot;
                          </code>
                        </li>
                        <li>
                          Boolean operators:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            android OR cyborg
                          </code>
                          ,{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            fantasy NOT elves
                          </code>
                        </li>
                        <li>
                          Parentheses for grouping:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            (vampire OR werewolf) &quot;modern city&quot;
                          </code>
                        </li>
                      </ul>
                    </div>

                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">
                        Filter Expression Examples:
                      </p>
                      <ul className="list-disc space-y-1.5 pl-5">
                        <li>
                          By ID:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            id:12345
                          </code>{' '}
                          or{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            id = 12345
                          </code>
                        </li>
                        <li>
                          Numeric:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tokenCount &gt; 2000
                          </code>
                          ,{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            rating &gt;= 4.5
                          </code>
                        </li>
                        <li>
                          Lists and ranges:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            source IN [&quot;ct&quot;, &quot;chub&quot;]
                          </code>{' '}
                          or{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tokenCount 1000 TO 5000
                          </code>
                        </li>
                        <li>
                          Text fields:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            author = &quot;anonymous&quot;
                          </code>
                          ,{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            source = &quot;ct&quot;
                          </code>
                        </li>
                        <li>
                          Tags shorthand:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tags:anime
                          </code>{' '}
                          converts to{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tags = &quot;anime&quot;
                          </code>
                        </li>
                        <li>
                          Combine:{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tokenCount &gt; 1500 AND hasLorebook = true
                          </code>
                        </li>
                        <li>
                          Section-specific (Chub cards):{' '}
                          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">
                            tokenDescriptionCount &gt;= 400 AND tokenScenarioCount &lt; 150
                          </code>
                        </li>
                      </ul>
                    </div>

                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">
                        Available Fields:
                      </p>
                      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2 gap-y-1 text-[11px]">
                        <code className="text-indigo-600 dark:text-indigo-400">
                          id, author, name, topics
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          tokenCount, rating
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          tokenDescriptionCount, tokenScenarioCount
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          tokenFirstMessageCount, tokenMesExampleCount
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          tokenPersonalityCount, tokenSystemPromptCount, tokenPostHistoryCount
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          source, language
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          hasLorebook, hasGallery
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          createdAt, lastModified
                        </code>
                        <code className="text-indigo-600 dark:text-indigo-400">
                          favorited, visibility
                        </code>
                      </div>
                    </div>
                  </Disclosure.Panel>
                </div>
              )}
            </Disclosure>
          </Disclosure.Panel>
        </div>
      )}
    </Disclosure>
  );
}
