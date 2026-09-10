'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import CreatableSelect from 'react-select/creatable';
import type { MultiValue, StylesConfig } from 'react-select';
import clsx from 'clsx';
import { searchTags as searchTagsApi } from '@/lib/api';
import type { TagOption } from '../types/filters';

type TagMultiSelectProps = {
    label: string;
    placeholder: string;
    selectedTags: string[];
    onChange: (tags: string[]) => void;
    suggestions: string[];
    blockedTags?: string[];
    isDark?: boolean;
    canonicalTags?: Set<string>;
    disabled?: boolean;
};

const buildSelectStyles = (isDark: boolean): StylesConfig<TagOption, true> => {
    const controlBg = 'transparent';
    const textColor = isDark ? '#e2e8f0' : '#1e293b';
    const placeholderColor = isDark ? '#94a3b8' : '#94a3b8';
    const menuBg = isDark ? '#0f172a' : '#ffffff';
    const optionHoverBg = isDark ? '#1f2937' : '#eef2ff';
    const multiBg = isDark ? '#1f2937' : '#e0e7ff';
    const multiText = isDark ? '#e2e8f0' : '#4338ca';
    const canonicalBg = isDark ? '#4338ca' : '#c7d2fe';
    const canonicalText = isDark ? '#f8fafc' : '#1e1b4b';
    const canonicalBorder = isDark ? '#a78bfa' : '#6366f1';
    const canonicalOptionBg = isDark ? '#312e81' : '#ede9fe';
    const canonicalOptionText = isDark ? '#c7d2fe' : '#3730a3';

    return {
        container: base => ({
            ...base,
            width: '100%',
        }),
        control: (base, state) => ({
            ...base,
            backgroundColor: controlBg,
            borderRadius: 6,
            border: 0,
            boxShadow: state.isFocused ? `0 0 0 2px rgba(99, 102, 241, 0.35)` : 'none',
            padding: '0 2px',
            minHeight: 32,
            cursor: 'text',
        }),
        valueContainer: base => ({
            ...base,
            gap: 2,
            padding: '1px 2px',
        }),
        placeholder: base => ({
            ...base,
            color: placeholderColor,
        }),
        input: base => ({
            ...base,
            color: textColor,
        }),
        multiValue: (base, state) => {
            const isCanonical = Boolean(state.data?.isCanonical);
            return {
                ...base,
                borderRadius: 4,
                margin: 1,
                backgroundColor: isCanonical ? canonicalBg : multiBg,
                color: isCanonical ? canonicalText : multiText,
                border: isCanonical ? `1px solid ${canonicalBorder}` : base.border,
            };
        },
        multiValueLabel: (base, state) => {
            const isCanonical = Boolean(state.data?.isCanonical);
            return {
                ...base,
                color: isCanonical ? canonicalText : multiText,
                fontWeight: 600,
                fontSize: '0.75rem',
                padding: '1px 4px',
            };
        },
        multiValueRemove: (base, state) => {
            const isCanonical = Boolean(state.data?.isCanonical);
            return {
                ...base,
                color: isCanonical ? canonicalText : multiText,
                ':hover': {
                    backgroundColor: 'transparent',
                    color: isDark ? '#f87171' : '#dc2626',
                },
            };
        },
        menu: base => ({
            ...base,
            marginTop: 8,
            backgroundColor: menuBg,
            borderRadius: 6,
            overflow: 'hidden',
            zIndex: 40,
        }),
        menuList: base => ({
            ...base,
            padding: 6,
        }),
        option: (base, state) => {
            const isCanonical = Boolean(state.data?.isCanonical);
            const isHighlighted = state.isFocused || state.isSelected;
            const backgroundColor = isHighlighted
                ? optionHoverBg
                : isCanonical
                    ? canonicalOptionBg
                    : 'transparent';
            const color = state.isSelected
                ? multiText
                : isCanonical
                    ? canonicalOptionText
                    : textColor;
            return {
                ...base,
                borderRadius: 4,
                fontSize: '0.875rem',
                fontWeight: state.isSelected ? 600 : isCanonical ? 600 : 500,
                backgroundColor,
                color,
                cursor: 'pointer',
            };
        },
        indicatorsContainer: base => ({
            ...base,
            color: placeholderColor,
        }),
        dropdownIndicator: base => ({
            ...base,
            padding: 6,
            color: placeholderColor,
            ':hover': {
                color: textColor,
            },
        }),
        clearIndicator: base => ({
            ...base,
            padding: 6,
        }),
        indicatorSeparator: base => ({
            ...base,
            display: 'none',
        }),
    };
};

export const TagMultiSelect: React.FC<TagMultiSelectProps> = ({
    label,
    placeholder,
    selectedTags,
    onChange,
    suggestions,
    blockedTags = [],
    isDark = false,
    canonicalTags,
    disabled = false,
}) => {
    const inputId = useId();
    const [isMounted, setIsMounted] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [searchResults, setSearchResults] = useState<string[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    useEffect(() => {
        const searchForTags = async () => {
            if (!inputValue || inputValue.length < 2) {
                setSearchResults([]);
                return;
            }

            setIsSearching(true);
            try {
                const results = await searchTagsApi(inputValue, 50);
                setSearchResults(results);
            } catch (err) {
                console.error('Tag search failed', err);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        };

        const timer = setTimeout(searchForTags, 300);
        return () => clearTimeout(timer);
    }, [inputValue]);

    const selectedLower = useMemo(() => new Set(selectedTags.map(tag => tag.toLowerCase())), [selectedTags]);
    const blockedLower = useMemo(() => new Set(blockedTags.map(tag => tag.toLowerCase())), [blockedTags]);
    const isCanonicalTag = useCallback(
        (tag: string) => (canonicalTags ? canonicalTags.has(tag.toLowerCase()) : false),
        [canonicalTags],
    );

    const options = useMemo<TagOption[]>(() => {
        const source = inputValue.length >= 2 ? searchResults : suggestions;
        return source
            .filter(tag => {
                const lower = tag.toLowerCase();
                return !selectedLower.has(lower) && !blockedLower.has(lower);
            })
            .map(tag => ({ value: tag, label: tag, isCanonical: isCanonicalTag(tag) }));
    }, [suggestions, searchResults, inputValue, selectedLower, blockedLower, isCanonicalTag]);

    const value = useMemo<TagOption[]>(
        () => selectedTags.map(tag => ({ value: tag, label: tag, isCanonical: isCanonicalTag(tag) })),
        [selectedTags, isCanonicalTag],
    );

    const styles = useMemo(() => buildSelectStyles(isDark), [isDark]);

    const handleChange = useCallback(
        (items: MultiValue<TagOption>) => {
            onChange(items.map(item => item.value));
        },
        [onChange],
    );

    const handleCreate = useCallback(
        (inputValue: string) => {
            const cleaned = inputValue.trim();
            if (!cleaned) return;
            if (selectedLower.has(cleaned.toLowerCase())) return;
            onChange([...selectedTags, cleaned]);
        },
        [onChange, selectedLower, selectedTags],
    );

    if (!isMounted) {
        return (
            <label className="flex min-w-0 flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</span>
                <div
                    className={clsx(
                        'min-h-[34px] rounded-md border px-1 py-0.5 shadow-inner transition',
                        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white',
                    )}
                >
                    <div className="flex flex-wrap gap-1">
                        {selectedTags.map(tag => (
                            <span
                                key={tag}
                                className={clsx(
                                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold',
                                    isCanonicalTag(tag)
                                        ? isDark
                                            ? 'bg-indigo-700 text-indigo-50'
                                            : 'bg-indigo-200 text-indigo-900'
                                        : isDark
                                            ? 'bg-gray-800 text-slate-200'
                                            : 'bg-slate-100 text-indigo-700',
                                )}
                            >
                                {tag}
                            </span>
                        ))}
                    </div>
                </div>
            </label>
        );
    }

    return (
        <div className={clsx('flex min-w-0 flex-col gap-1 text-sm text-slate-600 dark:text-slate-300', disabled && 'opacity-60')}>
            <label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</label>
            <div
                className={clsx(
                    'rounded-md border shadow-inner transition',
                    isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white',
                    disabled && 'pointer-events-none',
                )}
            >
                <CreatableSelect
                    inputId={inputId}
                    instanceId={inputId}
                    isMulti
                    value={value}
                    options={options}
                    styles={styles}
                    onChange={handleChange}
                    onCreateOption={handleCreate}
                    onInputChange={newValue => setInputValue(newValue)}
                    placeholder={selectedTags.length === 0 ? placeholder : ''}
                    classNamePrefix="tag-select"
                    formatCreateLabel={inputValue => `Add "${inputValue}"`}
                    noOptionsMessage={() =>
                        isSearching ? 'Searching...' : inputValue.length >= 2 ? 'No matching tags' : 'Type to search tags'
                    }
                    menuPlacement="auto"
                    hideSelectedOptions={false}
                    closeMenuOnSelect={false}
                    isClearable={false}
                    isLoading={isSearching}
                    isDisabled={disabled}
                />
            </div>
        </div>
    );
};
