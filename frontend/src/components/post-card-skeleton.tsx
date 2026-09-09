import { cn } from "@/lib/utils"

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted/70", className)} />
}

export function PostCardSkeleton() {
  return (
    <div className="w-full border-b border-border/50 p-4 sm:p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Bone className="size-10 shrink-0 rounded-full" />
        <div className="flex flex-col gap-1.5 flex-1">
          <Bone className="h-4 w-28 rounded-full" />
          <Bone className="h-3 w-20 rounded-full" />
        </div>
      </div>
      <Bone className="h-4 w-full rounded-md" />
      <Bone className="h-4 w-4/5 rounded-md" />
      <Bone className="h-32 w-full rounded-2xl" />
      <div className="flex items-center gap-6 pt-1">
        <Bone className="h-4 w-10 rounded-full" />
        <Bone className="h-4 w-10 rounded-full" />
      </div>
    </div>
  )
}
