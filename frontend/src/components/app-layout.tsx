import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import {
  BarChart3,
  Home,
  MessageSquare,
  Settings,
  User,
  LogOut,
  Moon,
  Sun,
  PenSquare,
  Radio,
} from "lucide-react"

import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"
import { useTheme } from "@/lib/theme-context"
import { getCurrentUser, type UserProfile } from "@/lib/user"
import { cn } from "@/lib/utils"

interface AppLayoutProps {
  children: React.ReactNode
  rightSidebar?: React.ReactNode
  headerTitle?: string
  headerAction?: React.ReactNode
  maxWidth?: string
  onNewPostClick?: () => void
}

export function AppLayout({
  children,
  rightSidebar,
  headerTitle,
  headerAction,
  maxWidth = "max-w-7xl",
  onNewPostClick,
}: AppLayoutProps) {
  const { user, signOut } = useAuth()
  const { resolvedTheme, toggleTheme } = useTheme()
  const location = useLocation()
  const [profile, setProfile] = React.useState<UserProfile | null>(null)

  React.useEffect(() => {
    let cancelled = false
    getCurrentUser()
      .then((data) => {
        if (!cancelled) setProfile(data)
      })
      .catch(() => {
        // Fallback gracefully to basic auth user info
      })
    return () => {
      cancelled = true
    }
  }, [])

  const currentUsername = profile?.username ?? user?.username ?? ""
  const displayName = profile?.displayName ?? user?.username ?? "Account"
  const avatarUrl =
    profile?.avatarUrl ??
    (currentUsername
      ? `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(currentUsername)}`
      : "")

  const navItems = [
    { label: "Home", href: "/", icon: Home, active: location.pathname === "/" },
    {
      label: "Go Live",
      href: "/live",
      icon: Radio,
      active: location.pathname.startsWith("/live"),
    },
    {
      label: "Studio",
      href: "/studio",
      icon: BarChart3,
      active: location.pathname.startsWith("/studio"),
    },
    {
      label: "Messages",
      href: "/messages",
      icon: MessageSquare,
      active: location.pathname.startsWith("/messages"),
    },
    {
      label: "Profile",
      href: currentUsername ? `/profile/${currentUsername}` : "/settings",
      icon: User,
      active: location.pathname.startsWith("/profile"),
    },
    {
      label: "Settings",
      href: "/settings",
      icon: Settings,
      active: location.pathname.startsWith("/settings"),
    },
  ]

  return (
    <div className="min-h-svh bg-background text-foreground flex justify-center">
      <div className={cn("flex w-full min-h-svh", maxWidth)}>
        {/* Desktop Sidebar (lg and up) */}
        <aside className="hidden lg:flex w-64 xl:w-72 flex-col justify-between border-r border-border/50 px-4 py-5 sticky top-0 h-screen select-none bg-background/50">
          <div className="flex flex-col gap-6">
            <Link
              to="/"
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-2xl hover:bg-muted/50 transition-colors w-fit"
            >
              <Logo size="default" />
            </Link>

            <nav className="flex flex-col gap-1">
              {navItems.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.label}
                    to={item.href}
                    className={cn(
                      "flex items-center gap-3.5 px-4 py-2.5 rounded-full text-[14.5px] font-medium transition-all duration-150",
                      item.active
                        ? "bg-primary text-primary-foreground font-semibold shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    )}
                  >
                    <Icon className={cn("size-5 shrink-0", item.active ? "stroke-[2.5]" : "stroke-[1.8]")} />
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </nav>

            {onNewPostClick && (
              <Button
                onClick={onNewPostClick}
                className="w-full h-11 rounded-full text-sm font-semibold shadow-sm hover:shadow transition-all cursor-pointer"
              >
                <PenSquare className="size-4 mr-2" />
                New Post
              </Button>
            )}
          </div>

          {/* User profile info & Theme toggle in sidebar */}
          <div className="flex flex-col gap-2.5 pt-3 border-t border-border/50">
            <div className="flex items-center justify-between px-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Appearance</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleTheme}
                className="rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
                aria-label="Toggle theme"
              >
                {resolvedTheme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </Button>
            </div>

            <div className="flex items-center justify-between p-2 rounded-2xl bg-card/60 border border-border/50 hover:bg-muted/40 transition-colors">
              <Link
                to={currentUsername ? `/profile/${currentUsername}` : "/settings"}
                className="flex items-center gap-3 min-w-0 flex-1 hover:opacity-85 transition-opacity"
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    className="size-9 rounded-full ring-1 ring-border/80 object-cover shrink-0"
                  />
                ) : (
                  <div className="size-9 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                    {currentUsername.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="flex flex-col min-w-0 leading-tight">
                  <span className="truncate text-xs font-semibold text-foreground">
                    {displayName}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    @{currentUsername}
                  </span>
                </div>
              </Link>

              <Button
                variant="ghost"
                size="icon-xs"
                onClick={signOut}
                title="Log out"
                aria-label="Log out"
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 cursor-pointer rounded-full"
              >
                <LogOut className="size-3.5" />
              </Button>
            </div>
          </div>
        </aside>

        {/* Central Content Area */}
        <main className="flex-1 min-w-0 flex flex-col min-h-screen pb-16 lg:pb-0">
          {/* Mobile Top Header */}
          <header className="sticky top-0 z-30 flex lg:hidden items-center justify-between px-4 py-2.5 bg-background/80 backdrop-blur-md border-b border-border/50">
            <Link to="/" className="flex items-center gap-2">
              <Logo size="sm" />
            </Link>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleTheme}
                aria-label="Toggle theme"
                className="text-muted-foreground hover:text-foreground rounded-full"
              >
                {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={signOut}
                aria-label="Log out"
                className="text-muted-foreground hover:text-destructive rounded-full"
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </header>

          {/* Optional Page Subheader */}
          {(headerTitle || headerAction) && (
            <div className="sticky top-0 z-20 hidden lg:flex items-center justify-between px-6 py-3.5 bg-background/80 backdrop-blur-md border-b border-border/50">
              <h1 className="text-base font-bold tracking-tight text-foreground">{headerTitle}</h1>
              {headerAction}
            </div>
          )}

          {/* Main child view */}
          <div className="flex-1 w-full">{children}</div>
        </main>

        {/* Right Sidebar (Desktop xl and up, if provided) */}
        {rightSidebar && (
          <aside className="hidden xl:flex w-80 2xl:w-92 flex-col gap-5 border-l border-border/50 px-5 py-5 sticky top-0 h-screen overflow-y-auto">
            {rightSidebar}
          </aside>
        )}

        {/* Mobile Bottom Navigation Bar */}
        <nav className="fixed bottom-0 left-0 right-0 z-40 flex lg:hidden items-center justify-around bg-background/90 backdrop-blur-lg border-t border-border/50 px-2 py-1.5 shadow-lg">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.label}
                to={item.href}
                className={cn(
                  "flex flex-col items-center justify-center py-1 px-3 rounded-full text-[10px] font-medium transition-colors",
                  item.active
                    ? "text-primary font-bold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn("size-5", item.active && "stroke-[2.5]")} />
                <span className="mt-0.5">{item.label}</span>
              </Link>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
