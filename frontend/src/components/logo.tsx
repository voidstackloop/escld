import { cn } from "@/lib/utils"

function Logo({
  className,
  iconOnly = false,
  size = "default",
}: {
  className?: string
  iconOnly?: boolean
  size?: "sm" | "default" | "lg" | "xl"
}) {
  const iconSize = {
    sm: "size-6",
    default: "size-8",
    lg: "size-10",
    xl: "size-12",
  }[size]

  const textSize = {
    sm: "text-base",
    default: "text-lg",
    lg: "text-2xl",
    xl: "text-3xl",
  }[size]

  return (
    <div className={cn("inline-flex items-center gap-2.5 select-none transition-transform hover:opacity-95", className)}>
      <div className="relative flex items-center justify-center shrink-0">
        <img
          src="/favicon.svg"
          alt=""
          className={cn(iconSize, "shrink-0 transition-transform duration-300 hover:scale-105 drop-shadow-[0_2px_8px_rgba(134,59,255,0.35)]")}
        />
      </div>
      {!iconOnly && (
        <span
          className={cn(
            "font-heading font-bold tracking-tight bg-gradient-to-r from-foreground via-foreground to-primary bg-clip-text text-transparent",
            textSize
          )}
        >
          escld
        </span>
      )}
    </div>
  )
}

export { Logo }
