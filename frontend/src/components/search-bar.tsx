import * as React from "react"
import { Link } from "react-router-dom"
import { Search, X, Check, Loader2 } from "lucide-react"

import { Input } from "@/components/ui/input"
import { searchUsers, type UserSearchResult } from "@/lib/search"
import { cn } from "@/lib/utils"

const DEBOUNCE_MS = 300

export function SearchBar({ className }: { className?: string }) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<UserSearchResult[]>([])
  const [loading, setLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results when the query is emptied
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)
    const timeout = setTimeout(() => {
      searchUsers(trimmed)
        .then((data) => setResults(data))
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, DEBOUNCE_MS)

    return () => clearTimeout(timeout)
  }, [query])

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const showDropdown = open && query.trim() !== ""

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3.5 size-4 text-muted-foreground/70" />
        <Input
          type="search"
          placeholder="Search on escld..."
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          className="h-10.5 pl-10 pr-9 rounded-full bg-muted/40 border-border/50 hover:bg-muted/60 focus:bg-background focus:border-primary/50 transition-all text-sm shadow-none"
        />
        {query.trim() && (
          <button
            type="button"
            onClick={() => {
              setQuery("")
              setResults([])
              setOpen(false)
            }}
            className="absolute right-3.5 text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute top-full z-30 mt-2 w-full overflow-hidden rounded-3xl border border-border/60 bg-popover/95 backdrop-blur-xl shadow-xl transition-all animate-in fade-in-50 zoom-in-95">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-3.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span>Searching users...</span>
            </div>
          )}

          {!loading && results.length === 0 && (
            <div className="px-4 py-5 text-center text-xs text-muted-foreground">
              No users found matching &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="max-h-72 overflow-y-auto divide-y divide-border/30">
              {results.map((result) => (
                <Link
                  key={result.id}
                  to={`/profile/${result.username}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/60 transition-colors"
                  onClick={() => {
                    setOpen(false)
                    setQuery("")
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={
                        result.avatarUrl ??
                        `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(result.username)}`
                      }
                      alt=""
                      className="size-9 shrink-0 rounded-full ring-1 ring-border/80 object-cover"
                    />
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="flex items-center gap-1 truncate text-xs font-bold text-foreground">
                        {result.displayName}
                        {result.verified && (
                          <span
                            className="inline-flex items-center justify-center size-3.5 rounded-full bg-primary text-primary-foreground text-[0.6rem]"
                            aria-label="Verified"
                            title="Verified user"
                          >
                            <Check className="size-2.5 stroke-[3]" />
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        @{result.username}
                      </span>
                    </div>
                  </div>

                  <span className="text-[11px] font-medium text-muted-foreground bg-muted/70 px-2.5 py-0.5 rounded-full shrink-0">
                    {result.followersCount} followers
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
