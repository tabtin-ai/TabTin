#!/usr/bin/env python3
"""Migrate module-page text-caption → canvasUi tokens ."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RENDERER = REPO / "src/renderer/src/components"

TARGETS = [
    RENDERER / "context-space/skills",
    RENDERER / "tabtracker",
    RENDERER / "context-space/registry/homeSections",
    RENDERER / "context-space/marketplace",
    RENDERER / "context-space/ContextDialogHeader.tsx",
    RENDERER / "context-space/CollectionsView.tsx",
    RENDERER / "layout/CanvasGroupLayout.tsx",
    RENDERER / "context-space/registry/homeSections/orchestration.tsx",
    RENDERER / "context-space/tabtracker/TabTrackerCapabilitiesDialog.tsx",
]

IMPORT = (
    "import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, "
    "CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'"
)

# Order matters — longer / more specific first.
SUBS = [
    ("'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-caption transition-colors'",
     "'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 transition-colors', CANVAS_TAB_TEXT"),
    ("'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption transition-colors'",
     "'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 transition-colors', CANVAS_TAB_TEXT"),
    ("'h-7 shrink-0 whitespace-nowrap px-2 text-caption'",
     "'h-7 shrink-0 whitespace-nowrap px-2', CANVAS_TAB_TEXT"),
    ("break-words text-caption leading-snug text-muted-foreground/70 line-clamp-1",
     "break-words CANVAS_TEXT_SECONDARY line-clamp-1"),
    ("break-words text-caption leading-snug text-muted-foreground/70",
     "break-words CANVAS_TEXT_SECONDARY"),
    ("text-caption leading-snug text-muted-foreground/70 line-clamp-1",
     "CANVAS_TEXT_SECONDARY line-clamp-1"),
    ("text-caption leading-snug text-muted-foreground/70",
     "CANVAS_TEXT_SECONDARY"),
    ("mt-1 line-clamp-2 text-caption text-muted-foreground/70",
     "mt-1 line-clamp-2 CANVAS_TEXT_SECONDARY"),
    ("line-clamp-2 text-caption leading-4 text-muted-foreground/65",
     "line-clamp-2 CANVAS_TEXT_SECONDARY"),
    ("whitespace-pre-wrap break-words text-caption leading-[1.7]",
     "whitespace-pre-wrap break-words CANVAS_TEXT_SECONDARY leading-[1.7]"),
    ("text-caption tabular-nums text-muted-foreground/45",
     "CANVAS_TEXT_META tabular-nums text-muted-foreground/45"),
    ("text-caption tabular-nums text-muted-foreground/60",
     "CANVAS_TEXT_META tabular-nums"),
    ("text-caption tabular-nums",
     "CANVAS_TEXT_META tabular-nums"),
    ("truncate text-caption text-muted-foreground/60",
     "truncate CANVAS_TEXT_META"),
    ("block truncate text-caption text-muted-foreground/60",
     "block truncate CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/60",
     "CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/80",
     "CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/70",
     "CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/65",
     "CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/45",
     "CANVAS_TEXT_META text-muted-foreground/45"),
    ("text-caption text-muted-foreground/40",
     "CANVAS_TEXT_META text-muted-foreground/40"),
    ("text-caption text-muted-foreground/55",
     "CANVAS_TEXT_META text-muted-foreground/55"),
    ("text-caption text-muted-foreground",
     "CANVAS_TEXT_META"),
    ("text-caption font-medium text-muted-foreground/60",
     "CANVAS_TEXT_META font-medium"),
    ("text-caption font-medium text-muted-foreground/80",
     "CANVAS_TEXT_META font-medium"),
    ("text-caption font-medium text-foreground/80",
     "CANVAS_TEXT_META_BASE font-medium text-foreground/80"),
    ("text-caption font-medium text-muted-foreground",
     "CANVAS_TEXT_META font-medium"),
    ("text-caption text-destructive/80",
     "CANVAS_TEXT_META_BASE text-destructive/80"),
    ("text-caption text-destructive",
     "CANVAS_TEXT_META_BASE text-destructive"),
    ("text-caption text-warning",
     "CANVAS_TEXT_META_BASE text-warning"),
    ("text-caption text-primary",
     "CANVAS_TEXT_META_BASE text-primary"),
    ("text-caption text-accent",
     "CANVAS_TEXT_META_BASE text-accent"),
    ("text-caption text-success",
     "CANVAS_TEXT_MICRO text-success"),
    ("text-caption text-primary/80",
     "CANVAS_TEXT_MICRO text-primary/80"),
    ("text-caption text-primary-text",
     "CANVAS_TEXT_MICRO text-primary-text"),
    ("text-caption text-amber-600 dark:text-amber-400",
     "CANVAS_TEXT_MICRO text-amber-600 dark:text-amber-400"),
    ("text-caption text-amber-600",
     "CANVAS_TEXT_MICRO text-amber-600"),
    ("shrink-0 text-caption text-muted-foreground",
     "shrink-0 CANVAS_TEXT_META"),
    ("flex items-center gap-2 text-caption text-muted-foreground/80",
     "flex items-center gap-2 CANVAS_TEXT_META"),
    ("inline-flex flex-wrap items-center gap-2 text-caption text-muted-foreground/60",
     "inline-flex flex-wrap items-center gap-2 CANVAS_TEXT_META"),
    ("mb-2 px-1 text-caption font-medium text-muted-foreground/60",
     "mb-2 px-1 CANVAS_TEXT_META font-medium"),
    ("px-2 text-caption text-muted-foreground/60 hover:text-foreground",
     "px-2 CANVAS_TEXT_META hover:text-foreground"),
    ("px-2 text-caption text-muted-foreground/60 hover:text-destructive",
     "px-2 CANVAS_TEXT_META hover:text-destructive"),
    ("ml-1.5 text-caption text-muted-foreground/40",
     "ml-1.5 CANVAS_TEXT_META text-muted-foreground/40"),
    ("py-2 text-caption text-muted-foreground/40",
     "py-2 CANVAS_TEXT_META text-muted-foreground/40"),
    ("text-center text-caption text-muted-foreground/60",
     "text-center CANVAS_TEXT_META"),
    ("h-7 px-2 text-caption",
     "h-7 px-2 CANVAS_TEXT_META"),
    ("h-7 gap-1 text-caption",
     "h-7 gap-1 CANVAS_TEXT_META"),
    ("h-8 text-caption",
     "h-8 CANVAS_TEXT_META"),
    ("col-span-2 h-8 text-caption",
     "col-span-2 h-8 CANVAS_TEXT_META"),
    ("h-7 shrink-0 px-2 text-caption text-success",
     "h-7 shrink-0 px-2 CANVAS_TEXT_MICRO text-success"),
    ("h-7 shrink-0 text-caption",
     "h-7 shrink-0 CANVAS_TEXT_META"),
    ("h-7 shrink-0 px-2 text-caption",
     "h-7 shrink-0 px-2 CANVAS_TEXT_META"),
    ("rounded-full bg-emerald-500/10 px-1.5 py-px text-caption font-medium",
     "rounded-full bg-emerald-500/10 px-1.5 py-px CANVAS_TEXT_MICRO font-medium"),
    ("shrink-0 inline-flex items-center gap-0.5 rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption text-primary-text",
     "shrink-0 inline-flex items-center gap-0.5 rounded-full bg-foreground/[0.04] px-1.5 py-px CANVAS_TEXT_MICRO text-primary-text"),
    ("rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption",
     "rounded-full bg-foreground/[0.04] px-1.5 py-px CANVAS_TEXT_MICRO"),
    ("rounded-full bg-foreground/[0.04] px-1.5 py-0.5 text-caption",
     "rounded-full bg-foreground/[0.04] px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("rounded-full bg-foreground/[0.04] px-2 py-0.5 text-caption font-medium",
     "rounded-full bg-foreground/[0.04] px-2 py-0.5 CANVAS_TEXT_MICRO font-medium"),
    ("rounded-full bg-foreground/[0.04] px-2 py-0.5 text-caption",
     "rounded-full bg-foreground/[0.04] px-2 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex items-center rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption",
     "inline-flex items-center rounded-full bg-foreground/[0.04] px-1.5 py-px CANVAS_TEXT_MICRO"),
    ("inline-flex items-center rounded-full bg-foreground/[0.04] px-1.5 py-0.5 text-caption",
     "inline-flex items-center rounded-full bg-foreground/[0.04] px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-caption",
     "inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 CANVAS_TEXT_MICRO"),
    ("max-w-full truncate rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption",
     "max-w-full truncate rounded-full bg-foreground/[0.04] px-1.5 py-px CANVAS_TEXT_MICRO"),
    ("inline-flex items-center gap-1 text-caption text-primary/80",
     "inline-flex items-center gap-1 CANVAS_TEXT_MICRO text-primary/80"),
    ("inline-flex items-center gap-1 text-caption text-success",
     "inline-flex items-center gap-1 CANVAS_TEXT_MICRO text-success"),
    ("justify-center gap-1 text-caption text-success",
     "justify-center gap-1 CANVAS_TEXT_MICRO text-success"),
    ("rounded px-1 py-px text-caption leading-tight font-medium",
     "rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium"),
    ("shrink-0 inline-flex items-center rounded px-1 py-px text-caption leading-tight font-medium",
     "shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium"),
    ("inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-caption",
     "inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex items-center rounded bg-destructive/10 px-1.5 py-0.5 text-caption",
     "inline-flex items-center rounded bg-destructive/10 px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-caption",
     "inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex w-fit items-center gap-1 rounded-full bg-foreground/[0.04] px-2 py-0.5 text-caption",
     "inline-flex w-fit items-center gap-1 rounded-full bg-foreground/[0.04] px-2 py-0.5 CANVAS_TEXT_MICRO"),
    ("inline-flex items-center rounded-full border border-warning/30 px-2 py-0.5 text-caption",
     "inline-flex items-center rounded-full border border-warning/30 px-2 py-0.5 CANVAS_TEXT_MICRO"),
    ("rounded-md border px-1.5 py-0.5 text-caption font-medium",
     "rounded-md border px-1.5 py-0.5 CANVAS_TEXT_MICRO font-medium"),
    ("rounded bg-muted px-1.5 py-0.5 text-caption",
     "rounded bg-muted px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("shrink-0 rounded bg-warning/10 px-1 py-0.5 text-caption",
     "shrink-0 rounded bg-warning/10 px-1 py-0.5 CANVAS_TEXT_MICRO"),
    ("shrink-0 rounded bg-foreground/[0.045] px-1.5 py-0.5 text-caption",
     "shrink-0 rounded bg-foreground/[0.045] px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-caption",
     "shrink-0 rounded bg-accent/10 px-1.5 py-0.5 CANVAS_TEXT_MICRO"),
    ("gap-1 rounded-full bg-foreground/[0.04] px-1.5 py-0.5 text-caption font-normal",
     "gap-1 rounded-full bg-foreground/[0.04] px-1.5 py-0.5 CANVAS_TEXT_MICRO font-normal"),
    ("text-caption font-normal text-muted-foreground/80",
     "CANVAS_TEXT_MICRO font-normal text-muted-foreground/80"),
    ("shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-caption leading-3",
     "shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 CANVAS_TEXT_MICRO leading-3"),
    ("px-2.5 py-1.5 text-caption font-medium text-muted-foreground",
     "px-2.5 py-1.5 CANVAS_TEXT_META font-medium"),
    ("px-2.5 py-1 text-caption text-muted-foreground/40",
     "px-2.5 py-1 CANVAS_TEXT_META text-muted-foreground/40"),
    ("px-2.5 py-1.5 text-caption text-muted-foreground",
     "px-2.5 py-1.5 CANVAS_TEXT_META"),
    ("px-3 py-1.5 text-caption text-muted-foreground/80",
     "px-3 py-1.5 CANVAS_TEXT_META"),
    ("px-3 py-4 text-caption text-muted-foreground/60",
     "px-3 py-4 CANVAS_TEXT_META"),
    ("px-3 py-4 text-caption",
     "px-3 py-4 CANVAS_TEXT_META"),
    ("p-4 text-caption text-destructive/80",
     "p-4 CANVAS_TEXT_META_BASE text-destructive/80"),
    ("p-4 text-caption text-muted-foreground/60",
     "p-4 CANVAS_TEXT_META"),
    ("p-4 text-caption",
     "p-4 CANVAS_TEXT_META"),
    ("flex h-full items-center justify-center p-4 text-caption text-muted-foreground/60",
     "flex h-full items-center justify-center p-4 CANVAS_TEXT_META"),
    ("flex h-full items-center justify-center p-4 text-caption",
     "flex h-full items-center justify-center p-4 CANVAS_TEXT_META"),
    ("rounded-lg border border-dashed py-6 text-center text-caption text-muted-foreground/60",
     "rounded-lg border border-dashed py-6 text-center CANVAS_TEXT_META"),
    ("w-full gap-1 text-caption",
     "w-full gap-1 CANVAS_TEXT_META"),
    ("mt-2 flex items-center gap-1.5 text-caption text-muted-foreground/80",
     "mt-2 flex items-center gap-1.5 CANVAS_TEXT_META"),
    ("truncate pl-1 text-caption font-medium text-muted-foreground/80",
     "truncate pl-1 CANVAS_TEXT_META font-medium"),
    ("block text-caption font-medium text-foreground/80",
     "block CANVAS_TEXT_META font-medium text-foreground/80"),
    ("block text-caption text-muted-foreground/70",
     "block CANVAS_TEXT_META"),
    ("text-caption text-muted-foreground/60 min-w-0 truncate",
     "CANVAS_TEXT_META min-w-0 truncate"),
    ("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption text-muted-foreground",
     "inline-flex items-center gap-1.5 rounded-md px-2 py-1 CANVAS_TEXT_META"),
    ("rounded-md px-2 py-1 text-caption text-muted-foreground",
     "rounded-md px-2 py-1 CANVAS_TEXT_META"),
    ("text-caption font-medium text-muted-foreground/80 mb-1.5",
     "CANVAS_TEXT_META font-medium mb-1.5"),
    ("flex-1 h-7 gap-1.5 text-caption",
     "flex-1 h-7 gap-1.5 CANVAS_TEXT_META"),
    ("w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-caption text-foreground/80",
     "w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 CANVAS_TEXT_META text-foreground/80"),
    ("text-caption cursor-pointer select-none",
     "CANVAS_TEXT_META cursor-pointer select-none"),
    ("mt-0.5 text-caption text-muted-foreground/60 leading-relaxed",
     "mt-0.5 CANVAS_TEXT_META leading-relaxed"),
    ("text-caption text-muted-foreground/60 leading-relaxed",
     "CANVAS_TEXT_META leading-relaxed"),
    ("py-8 text-center text-caption text-muted-foreground/60",
     "py-8 text-center CANVAS_TEXT_META"),
    ("flex items-center justify-center gap-2 py-8 text-caption text-muted-foreground/80",
     "flex items-center justify-center gap-2 py-8 CANVAS_TEXT_META"),
    ("mt-2 text-caption text-accent hover:underline",
     "mt-2 CANVAS_TEXT_META_BASE text-accent hover:underline"),
    ("text-caption text-accent hover:text-accent/80",
     "CANVAS_TEXT_META_BASE text-accent hover:text-accent/80"),
    ("min-w-0 truncate font-mono text-caption leading-4 text-foreground",
     "min-w-0 truncate font-mono CANVAS_TEXT_META leading-4 text-foreground"),
    ("text-caption font-medium text-foreground",
     "CANVAS_TEXT_META_BASE font-medium text-foreground"),
    ("ml-auto text-caption text-muted-foreground/60",
     "ml-auto CANVAS_TEXT_META"),
    ("text-caption text-foreground/40 shrink-0",
     "CANVAS_TEXT_META text-foreground/40 shrink-0"),
    ("truncate text-caption text-foreground/60",
     "truncate CANVAS_TEXT_META text-foreground/60"),
    ("text-caption font-medium text-foreground/60 shrink-0",
     "CANVAS_TEXT_META font-medium text-foreground/60 shrink-0"),
    ("ml-auto shrink-0 text-caption text-foreground/40",
     "ml-auto shrink-0 CANVAS_TEXT_META text-foreground/40"),
    ("className=\"text-caption text-muted-foreground/60\"",
     "className={CANVAS_TEXT_META}"),
    ('className="text-caption text-muted-foreground/60"',
     "className={CANVAS_TEXT_META}"),
    ("<p className=\"text-caption text-muted-foreground\">",
     "<p className={CANVAS_TEXT_META}>"),
    ("<p className=\"text-caption text-muted-foreground/60\">",
     "<p className={CANVAS_TEXT_META}>"),
    ("<div className=\"text-caption text-muted-foreground/60\">",
     "<div className={CANVAS_TEXT_META}>"),
    ("<span className=\"text-caption text-muted-foreground/60\">",
     "<span className={CANVAS_TEXT_META}>"),
    ("<span className=\"text-caption font-medium text-muted-foreground/80\">",
     "<span className={cn('font-medium', CANVAS_TEXT_META)}>"),
    ("<div key={i} className=\"text-caption\">",
     "<div key={i} className={CANVAS_TEXT_META_BASE}>"),
    ("text-caption text-muted-foreground/60 py-2",
     "CANVAS_TEXT_META py-2"),
    ("text-caption text-muted-foreground py-2",
     "CANVAS_TEXT_META py-2"),
    ("text-caption text-muted-foreground/60\">{t('skills.empty')}",
     "CANVAS_TEXT_META\">{t('skills.empty')}"),
    ("text-caption\">{t('skills.panel.loadError')}",
     "CANVAS_TEXT_META\">{t('skills.panel.loadError')}"),
    ("text-caption m-0",
     "CANVAS_TEXT_META m-0"),
    ("text-caption leading-none",
     "CANVAS_TEXT_MICRO leading-none"),
    ("text-caption leading-tight",
     "CANVAS_TEXT_MICRO leading-tight"),
    ("text-caption leading-relaxed",
     "CANVAS_TEXT_META leading-relaxed"),
    ("text-caption leading-4",
     "CANVAS_TEXT_META leading-4"),
    ("text-caption ml-0.5",
     "CANVAS_TEXT_MICRO ml-0.5"),
    ("hover:text-destructive text-caption ml-0.5",
     "hover:text-destructive CANVAS_TEXT_MICRO ml-0.5"),
    ("hover:text-destructive text-caption leading-none",
     "hover:text-destructive CANVAS_TEXT_MICRO leading-none"),
    ("text-muted-foreground/40 hover:text-destructive text-caption leading-none",
     "text-muted-foreground/40 hover:text-destructive CANVAS_TEXT_MICRO leading-none"),
    ("text-muted-foreground/60 hover:text-destructive text-caption ml-0.5",
     "text-muted-foreground/60 hover:text-destructive CANVAS_TEXT_MICRO ml-0.5"),
    ("text-caption text-muted-foreground/60\">{text}",
     "CANVAS_TEXT_META\">{text}"),
    ("text-caption\">",
     "CANVAS_TEXT_META\">"),
    (" text-caption ",
     " CANVAS_TEXT_META "),
    (" text-caption'",
     " CANVAS_TEXT_META'"),
    (' text-caption"',
     ' CANVAS_TEXT_META"'),
    ("`text-caption",
     "`${CANVAS_TEXT_META}"),
]


def iter_files() -> list[Path]:
    out: list[Path] = []
    for target in TARGETS:
        if target.is_file():
            if "text-caption" in target.read_text(encoding="utf-8"):
                out.append(target)
            continue
        if not target.exists():
            continue
        for path in target.rglob("*.tsx"):
            if path.name.endswith(".test.tsx"):
                continue
            if "text-caption" in path.read_text(encoding="utf-8"):
                out.append(path)
    return sorted(set(out))


def needs_tokens(content: str) -> bool:
    tokens = (
        "CANVAS_TEXT_META",
        "CANVAS_TEXT_META_BASE",
        "CANVAS_TEXT_SECONDARY",
        "CANVAS_TAB_TEXT",
        "CANVAS_TEXT_MICRO",
    )
    return any(t in content for t in tokens)


def ensure_import(content: str) -> str:
    if "@components/layout/canvasUi" in content:
        return content
    m = re.search(r"^import \{ cn \} from '@utils/cn'\n", content, re.M)
    if m:
        return content[: m.end()] + IMPORT + "\n" + content[m.end() :]
    m = re.search(r"^(import .+\n)+", content)
    if m:
        return content[: m.end()] + IMPORT + "\n" + content[m.end() :]
    return IMPORT + "\n" + content


def migrate(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    content = original
    for old, new in SUBS:
        content = content.replace(old, new)
    if content == original:
        return False
    if needs_tokens(content):
        content = ensure_import(content)
    path.write_text(content, encoding="utf-8")
    return True


def main() -> int:
    changed = 0
    remaining: list[tuple[str, int]] = []
    for path in iter_files():
        if migrate(path):
            changed += 1
        n = path.read_text(encoding="utf-8").count("text-caption")
        if n:
            remaining.append((str(path.relative_to(REPO)), n))
    print(f"migrated {changed} files")
    for rel, n in remaining:
        print(f"  {n:3d}  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
