import { useState, useEffect } from "react";
import { useGetGithubRepos, queryConfig } from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Github, ChevronsUpDown, Check } from "lucide-react";

interface RepoComboboxProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function RepoCombobox({ value, onChange, disabled }: RepoComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data: recentData,
    isError,
    isLoading,
  } = useGetGithubRepos(undefined, {
    query: queryConfig({ staleTime: 60_000, retry: false }),
  });

  const { data: searchData, isFetching: isSearching } = useGetGithubRepos(
    { q: debouncedSearch },
    { query: queryConfig({ enabled: !!debouncedSearch, staleTime: 30_000, retry: false }) },
  );

  if (isError) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://github.com/owner/repo"
        className="font-mono bg-background text-sm"
        disabled={disabled}
      />
    );
  }

  const baseRepos = recentData?.repos ?? [];
  const repos = debouncedSearch
    ? (searchData?.repos ??
      baseRepos.filter((r) => r.fullName.toLowerCase().includes(search.toLowerCase())))
    : search
      ? baseRepos.filter((r) => r.fullName.toLowerCase().includes(search.toLowerCase()))
      : baseRepos;

  const allKnown = [...baseRepos, ...(searchData?.repos ?? [])];
  const selectedRepo = allKnown.find((r) => r.htmlUrl === value);
  const displayValue = selectedRepo?.fullName ?? value ?? null;

  const showCustomUrl =
    !!search && search.startsWith("https://") && !repos.some((r) => r.htmlUrl === search);

  const handleSelect = (htmlUrl: string) => {
    onChange(htmlUrl);
    setSearch("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-mono text-sm bg-background h-9 px-3"
          disabled={disabled}
          type="button"
        >
          <span className={displayValue ? "text-foreground" : "text-muted-foreground"}>
            {displayValue ?? "https://github.com/owner/repo"}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search repos or paste a URL…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {(isLoading || isSearching) && !repos.length && (
              <div className="py-3 px-4 text-xs text-muted-foreground">
                {isSearching ? "Searching…" : "Loading your repos…"}
              </div>
            )}

            {!isLoading && !isSearching && repos.length === 0 && !showCustomUrl && (
              <CommandEmpty>No repos found.</CommandEmpty>
            )}

            {repos.length > 0 && (
              <CommandGroup heading={debouncedSearch ? "Search results" : "Your repos"}>
                {repos.map((repo) => (
                  <CommandItem
                    key={repo.htmlUrl}
                    value={repo.fullName}
                    onSelect={() => handleSelect(repo.htmlUrl)}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Check
                        className={`h-3.5 w-3.5 shrink-0 ${
                          value === repo.htmlUrl ? "opacity-100" : "opacity-0"
                        }`}
                      />
                      <span className="font-mono text-sm truncate">{repo.fullName}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0 py-0">
                      {repo.private ? "private" : "public"}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showCustomUrl && (
              <CommandGroup>
                <CommandItem value={search} onSelect={() => handleSelect(search.trim())}>
                  <Github className="mr-2 h-3.5 w-3.5 opacity-70 shrink-0" />
                  <span className="font-mono text-sm truncate">Use &ldquo;{search}&rdquo;</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
