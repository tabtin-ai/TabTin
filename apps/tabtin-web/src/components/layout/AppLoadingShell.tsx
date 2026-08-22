export function AppLoadingShell() {
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4" style={{ background: 'hsl(var(--canvas))' }}>
      <div className="text-heading font-bold text-primary tracking-wide">TabTin</div>
      <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/2 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-primary/60" />
      </div>
    </div>
  )
}
