import { Disclosure } from "@headlessui/react";
import { BookmarkPlus, ChevronDown, Search, Sparkles, X } from "lucide-react";
import clsx from "clsx";
import { TagMultiSelect } from "./TagMultiSelect";
import type { FiltersState, SavedSearch } from "../types/filters";

interface FilterBarProps {
  filters: FiltersState;
  searchInputValue: string;
  advancedFilterInput: string;
  includeTagsSelected: string[];
  excludeTagsSelected: string[];
  tagSuggestions: string[];
  savedSearches: SavedSearch[];
  darkMode: boolean;
  hasFollowedCreators: boolean;
  canonicalTagSet?: Set<string>;
  onSearchInputChange: (value: string) => void;
  onAdvancedFilterChange: (value: string) => void;
  onIncludeTagsChange: (tags: string[]) => void;
  onExcludeTagsChange: (tags: string[]) => void;
  onFilterChange: (updates: Partial<FiltersState>) => void;
  onSearchSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onClearFilters: () => void;
  onSaveSearch: () => void;
  onApplySavedSearch: (search: SavedSearch) => void;
  onRemoveSavedSearch: (id: string) => void;
}

/**
 * Comprehensive filter bar component with search, tags, and advanced filters
 * Handles all filtering UI and delegates state changes to parent
 */
export function FilterBar({
  filters,
  searchInputValue,
  advancedFilterInput,
  includeTagsSelected,
  excludeTagsSelected,
  tagSuggestions,
  savedSearches,
  darkMode,
  hasFollowedCreators,
  canonicalTagSet,
  onSearchInputChange,
  onAdvancedFilterChange,
  onIncludeTagsChange,
  onExcludeTagsChange,
  onFilterChange,
  onSearchSubmit,
  onClearFilters,
  onSaveSearch,
  onApplySavedSearch,
  onRemoveSavedSearch,
}: FilterBarProps) {
  return (
    <>
      <form
        onSubmit={onSearchSubmit}
        className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900"
      >
        <label className="flex flex-col gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span className="font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Search</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              name="searchTerm"
              value={searchInputValue}
              onChange={event => onSearchInputChange(event.target.value)}
              placeholder="Name, description, author..."
              className="w-full rounded-2xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
        </label>

        <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700 shadow-inner dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Advanced Filter Expression (Optional)
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Power users can enter custom filter expressions for complex queries. Leave empty to use basic filters above.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Filter expression (optional)
              <textarea
                value={advancedFilterInput}
                onChange={event => onAdvancedFilterChange(event.target.value)}
                placeholder='source = "chub" AND author = "anonymous" AND tokenCount > 1000'
                className="min-h-[92px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                Colon syntax (tags:lightsaber) is accepted and converted for the selected search backend.
              </span>
            </label>
            <Disclosure>
              {({ open }) => (
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 px-4 py-3 text-xs text-slate-700 shadow-inner dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-slate-300">
                  <Disclosure.Button className="flex w-full items-center justify-between font-semibold">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                      Advanced Search Help
                    </span>
                    <ChevronDown className={clsx("h-4 w-4 transition-transform", open && "rotate-180")} />
                  </Disclosure.Button>
                  <Disclosure.Panel className="mt-3 space-y-3 text-left">
                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">Query String Tips:</p>
                      <ul className="list-disc space-y-1.5 pl-5">
                        <li>Use quotes for exact phrases: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">&quot;space opera&quot;</code></li>
                        <li>Boolean operators: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">android OR cyborg</code>, <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">fantasy NOT elves</code></li>
                        <li>Parentheses for grouping: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">(vampire OR werewolf) &quot;modern city&quot;</code></li>
                      </ul>
                    </div>

                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">Filter Expression Examples:</p>
                      <ul className="list-disc space-y-1.5 pl-5">
                        <li>By ID: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">id:12345</code> or <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">id = 12345</code></li>
                        <li>Numeric: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">tokenCount &gt; 2000</code>, <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">rating &gt;= 4.5</code></li>
                        <li>Text fields: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">author = &quot;anonymous&quot;</code>, <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">source = &quot;ct&quot;</code></li>
                        <li>Tags shorthand: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">tags:anime</code> converts to <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">tags = &quot;anime&quot;</code></li>
                        <li>Combine: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">tokenCount &gt; 1500 AND hasLorebook = true</code></li>
                        <li>Section-specific (Chub cards): <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-800 shadow-sm dark:bg-slate-900 dark:text-indigo-200">tokenDescriptionCount &gt;= 400 AND tokenScenarioCount &lt; 150</code></li>
                      </ul>
                    </div>

                    <div className="space-y-2">
                      <p className="font-semibold text-indigo-700 dark:text-indigo-300">Available Fields:</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                        <code className="text-indigo-600 dark:text-indigo-400">id, author, name, topics</code>
                        <code className="text-indigo-600 dark:text-indigo-400">tokenCount, rating</code>
                        <code className="text-indigo-600 dark:text-indigo-400">tokenDescriptionCount, tokenScenarioCount</code>
                        <code className="text-indigo-600 dark:text-indigo-400">tokenFirstMessageCount, tokenMesExampleCount</code>
                        <code className="text-indigo-600 dark:text-indigo-400">tokenPersonalityCount, tokenSystemPromptCount, tokenPostHistoryCount</code>
                        <code className="text-indigo-600 dark:text-indigo-400">source, language</code>
                        <code className="text-indigo-600 dark:text-indigo-400">hasLorebook, hasGallery</code>
                        <code className="text-indigo-600 dark:text-indigo-400">createdAt, lastModified</code>
                        <code className="text-indigo-600 dark:text-indigo-400">favorited, visibility</code>
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-indigo-200 bg-white/60 p-3 dark:border-indigo-900 dark:bg-slate-900/40">
                      <p className="flex items-start gap-2 text-[11px]">
                        <span className="text-indigo-600 dark:text-indigo-400">💡</span>
                        <span>After syncing new cards, refresh the search index with <code className="rounded bg-indigo-100 px-1 py-0.5 font-mono text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">npm run sync:search</code> to keep results up-to-date.</span>
                      </p>
                    </div>
                  </Disclosure.Panel>
                </div>
              )}
            </Disclosure>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Tag Filters
            </span>
            <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white p-1 text-xs font-medium shadow-inner dark:border-slate-700 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => onFilterChange({ tagMatchMode: "or" })}
                className={clsx(
                  "rounded-full px-3 py-1 transition",
                  filters.tagMatchMode === "or"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                )}
              >
                Match ANY
              </button>
              <button
                type="button"
                onClick={() => onFilterChange({ tagMatchMode: "and" })}
                className={clsx(
                  "rounded-full px-3 py-1 transition",
                  filters.tagMatchMode === "and"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                )}
              >
                Match ALL
              </button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TagMultiSelect
              label="Include tags"
              placeholder="Add tag"
              selectedTags={includeTagsSelected}
              onChange={onIncludeTagsChange}
              suggestions={tagSuggestions}
              blockedTags={excludeTagsSelected}
              isDark={darkMode}
              canonicalTags={canonicalTagSet}
            />
            <TagMultiSelect
              label="Exclude tags"
              placeholder="Add tag"
              selectedTags={excludeTagsSelected}
              onChange={onExcludeTagsChange}
              suggestions={tagSuggestions}
              blockedTags={includeTagsSelected}
              isDark={darkMode}
              canonicalTags={canonicalTagSet}
            />
          </div>
          <input type="hidden" name="includeTags" value={includeTagsSelected.join(",")} />
          <input type="hidden" name="excludeTags" value={excludeTagsSelected.join(",")} />
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Sort
            <select
              name="sort"
              value={filters.sort}
              onChange={e => onFilterChange({ sort: e.target.value })}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="recently_added">Recently added to collection</option>
              <option value="new">Recently updated</option>
              <option value="old">Oldest updated</option>
              <option value="create_new">Newest created</option>
              <option value="create_old">Oldest created</option>
              <option value="tokens_desc">Most tokens</option>
              <option value="tokens_asc">Fewest tokens</option>
              <option value="most_stars_desc">Most stars</option>
              <option value="most_favs_desc">Most favorites</option>
              <option value="overall_rating_desc">Overall user rating</option>
              <option value="trending_desc">Trending (age-adjusted)</option>
              <option value="engagement_desc">Engagement (usage-weighted)</option>
              <option value="fresh_engagement_desc">Fresh engagement (usage + recency)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Favorites
            <select
              name="favorite"
              value={filters.favorite}
              onChange={e => onFilterChange({ favorite: e.target.value as typeof filters.favorite })}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">All</option>
              <option value="fav">Favorited</option>
              <option value="not_fav">Not favorited</option>
              <option value="shadowban">Shadowbanned</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Source
            <select
              name="source"
              value={filters.source}
              onChange={e => onFilterChange({ source: e.target.value as typeof filters.source })}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="all">All</option>
              <option value="chub">Chub</option>
              <option value="ct">Character Tavern</option>
              <option value="risuai">RisuAI</option>
              <option value="wyvern">Wyvern</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Min tokens
            <input
              type="number"
              min={0}
              name="minTokens"
              value={filters.minTokens}
              onChange={e => onFilterChange({ minTokens: e.target.value })}
              placeholder="0"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onClearFilters}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Clear filters
            </button>
          </div>
        </div>

        <Disclosure defaultOpen={false}>
          {({ open }) => (
            <div className="rounded-3xl border border-slate-200 bg-white shadow-inner dark:border-slate-800 dark:bg-slate-900">
              <Disclosure.Button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100">
                Advanced Flags
                <ChevronDown className={clsx('h-4 w-4 transition-transform', open ? 'rotate-180' : 'rotate-0')} />
              </Disclosure.Button>
              <Disclosure.Panel className="border-t border-slate-100 px-4 py-4 dark:border-slate-800">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="hasAlternateGreetings"
                      checked={filters.hasAlternateGreetings}
                      onChange={e => onFilterChange({ hasAlternateGreetings: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Alternate Greetings
                  </label>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="hasLorebook"
                      checked={filters.hasLorebook}
                      onChange={e => onFilterChange({ hasLorebook: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Lorebook(s)
                  </label>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="hasGallery"
                      checked={filters.hasGallery}
                      onChange={e => onFilterChange({ hasGallery: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Gallery
                  </label>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="hasEmbeddedImages"
                      checked={filters.hasEmbeddedImages}
                      onChange={e => onFilterChange({ hasEmbeddedImages: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Embedded Images
                  </label>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="hasExpressions"
                      checked={filters.hasExpressions}
                      onChange={e => onFilterChange({ hasExpressions: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Expressions
                  </label>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                    <input
                      type="checkbox"
                      name="inSillyTavern"
                      checked={filters.inSillyTavern}
                      onChange={e => onFilterChange({ inSillyTavern: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Loaded in SillyTavern
                  </label>
                  <label
                    className={clsx(
                      "flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium shadow-inner transition",
                      hasFollowedCreators
                        ? "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200"
                        : "border-dashed border-slate-200 bg-slate-100 text-slate-400 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-500"
                    )}
                  >
                    <input
                      type="checkbox"
                      name="followedOnly"
                      checked={filters.followedOnly}
                      onChange={e => onFilterChange({ followedOnly: e.target.checked })}
                      disabled={!hasFollowedCreators}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Followed Creators Only
                  </label>
                </div>
              </Disclosure.Panel>
            </div>
          )}
        </Disclosure>
      </form>

      <Disclosure>
        {({ open }) => (
          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Disclosure.Button className="flex w-full items-center justify-between px-6 py-4 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Saved Searches {savedSearches.length > 0 && `(${savedSearches.length})`}
              </span>
              <ChevronDown className={clsx("h-4 w-4 text-slate-400 transition-transform", open && "rotate-180")} />
            </Disclosure.Button>
            <Disclosure.Panel className="border-t border-slate-200 px-6 py-4 dark:border-slate-700">
              {savedSearches.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-4">
                  <p className="text-sm text-slate-500 dark:text-slate-400">No saved searches yet.</p>
                  <button
                    onClick={onSaveSearch}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" /> Save current search
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    {savedSearches.map(search => (
                      <div
                        key={search.id}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-800"
                      >
                        <button
                          type="button"
                          onClick={() => onApplySavedSearch(search)}
                          className="font-semibold uppercase tracking-wide text-slate-600 transition hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-200"
                        >
                          {search.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveSavedSearch(search.id)}
                          aria-label={`Remove saved search ${search.name}`}
                          className="rounded-full p-1 text-slate-400 transition hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={onSaveSearch}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" /> Save current search
                  </button>
                </div>
              )}
            </Disclosure.Panel>
          </div>
        )}
      </Disclosure>
    </>
  );
}
