import * as React from "react"
import { Link } from "react-router-dom"
import { Sun, Moon } from "lucide-react"

import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useTheme } from "@/lib/theme-context"

function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  const { resolvedTheme, toggleTheme } = useTheme()

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-12 selection:bg-primary/20">
      {/* Top Bar with Theme Toggle */}
      <div className="absolute top-4 right-4 z-20">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>

      {/* Main Auth Container */}
      <div className="relative z-10 flex w-full max-w-md flex-col items-center gap-6">
        <Link to="/" aria-label="escld home" className="hover:opacity-90 transition-opacity">
          <Logo size="lg" />
        </Link>

        <Card className="w-full rounded-3xl border-border/50 bg-card/70 backdrop-blur-xl shadow-lg overflow-hidden">
          <CardHeader className="p-6 sm:p-7 pb-2 text-center">
            <CardTitle className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              {title}
            </CardTitle>
            {description && (
              <CardDescription className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">
                {description}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="p-6 sm:p-7 pt-2 flex flex-col gap-4">
            {children}
          </CardContent>
        </Card>

        {footer && (
          <div className="text-center text-xs text-muted-foreground font-medium">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export { AuthLayout }
