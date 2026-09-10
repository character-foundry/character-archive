'use client';

import { type ReactNode } from 'react';
import { Disclosure } from '@headlessui/react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const MarkdownContent = ({ content }: { content: string }) => (
    <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
            p: ({ children, ...props }) => (
                <p className="mb-3 leading-relaxed text-slate-600 last:mb-0 dark:text-slate-300" {...props}>
                    {children}
                </p>
            ),
            ul: ({ children, ...props }) => (
                <ul className="mb-3 list-disc space-y-2 pl-5 text-slate-600 last:mb-0 dark:text-slate-300" {...props}>
                    {children}
                </ul>
            ),
            ol: ({ children, ...props }) => (
                <ol className="mb-3 list-decimal space-y-2 pl-5 text-slate-600 last:mb-0 dark:text-slate-300" {...props}>
                    {children}
                </ol>
            ),
            li: ({ children, ...props }) => (
                <li className="leading-relaxed text-slate-600 dark:text-slate-300" {...props}>
                    {children}
                </li>
            ),
            strong: ({ children, ...props }) => (
                <strong className="font-semibold text-slate-700 dark:text-slate-100" {...props}>
                    {children}
                </strong>
            ),
            em: ({ children, ...props }) => (
                <em className="text-slate-600 dark:text-slate-300" {...props}>
                    {children}
                </em>
            ),
            code: ({ children, ...props }) => (
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200" {...props}>
                    {children}
                </code>
            ),
            pre: ({ children, ...props }) => (
                <pre className="mb-3 overflow-x-auto rounded-lg bg-slate-900/95 p-4 text-xs text-slate-50 last:mb-0" {...props}>
                    {children}
                </pre>
            ),
            a: ({ children, ...props }) => (
                <a
                    className="break-words font-semibold text-indigo-600 underline decoration-indigo-400 underline-offset-2 dark:text-indigo-300"
                    target="_blank"
                    rel="noreferrer"
                    {...props}
                >
                    {children}
                </a>
            ),
            img: ({ ...props }) => (
                // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
                <img
                    className="my-4 w-full max-w-full rounded-lg border border-slate-200/70 object-cover shadow-sm dark:border-slate-700"
                    {...props}
                />
            ),
            blockquote: ({ children, ...props }) => (
                <blockquote className="mb-3 border-l-4 border-indigo-500/60 pl-4 italic text-slate-600 last:mb-0 dark:text-slate-300" {...props}>
                    {children}
                </blockquote>
            ),
        }}
    >
        {content}
    </ReactMarkdown>
);

export const CollapsibleSection = ({
    title,
    children,
    renderContent,
    defaultOpen = false,
}: {
    title: string;
    children?: ReactNode;
    renderContent?: () => ReactNode;
    defaultOpen?: boolean;
}) => (
    <Disclosure defaultOpen={defaultOpen}>
        {({ open }) => (
            <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-slate-50/70 shadow-sm dark:border-slate-700/80 dark:bg-slate-900/50">
                <Disclosure.Button className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                    <span>{title}</span>
                    <ChevronDown className={clsx('h-4 w-4 transition-transform', open ? 'rotate-180' : '')} />
                </Disclosure.Button>
                <Disclosure.Panel className="border-t border-slate-200/70 px-4 py-2 text-sm leading-relaxed text-slate-600 dark:border-slate-700/70 dark:text-slate-300">
                    {open ? (renderContent ? renderContent() : children) : null}
                </Disclosure.Panel>
            </div>
        )}
    </Disclosure>
);

export const NestedSection = ({
    title,
    children,
    renderContent,
    defaultOpen = false,
}: {
    title: string;
    children?: ReactNode;
    renderContent?: () => ReactNode;
    defaultOpen?: boolean;
}) => (
    <Disclosure defaultOpen={defaultOpen}>
        {({ open }) => (
            <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/90 dark:border-slate-700/70 dark:bg-slate-900/40">
                <Disclosure.Button className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <span className="line-clamp-1">{title}</span>
                    <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open ? 'rotate-180' : '')} />
                </Disclosure.Button>
                <Disclosure.Panel className="border-t border-slate-200/70 px-3 py-1.5 text-sm leading-relaxed text-slate-600 dark:border-slate-700/70 dark:text-slate-300">
                    {open ? (renderContent ? renderContent() : children) : null}
                </Disclosure.Panel>
            </div>
        )}
    </Disclosure>
);
