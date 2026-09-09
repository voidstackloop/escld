import * as React from "react"
import { Link, useParams } from "react-router-dom"
import {
  MapPin,
  Link as LinkIcon,
  Calendar,
  Check,
  Lock,
  MessageSquare,
  Edit3,
  Loader2,
} from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { PostList } from "@/components/post-list"
import { SearchBar } from "@/components/search-bar"
import { TrendingWidget } from "@/components/trending-widget"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"
import { followUser, getFollowStatus, unfollowUser, type FollowState } from "@/lib/follow"
import { getPostsByUser } from "@/lib/post"
import { getCurrentUser, getPublicUser, type PublicUserProfile } from "@/lib/user"

function formatJoinDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(iso)
  )
}

export default function Profile() {
  const { username } = useParams<{ username: string }>()

  const [profile, setProfile] = React.useState<PublicUserProfile | null>(null)
  const [ownUsername, setOwnUsername] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [followState, setFollowState] = React.useState<FollowState>("NOT_FOLLOWING")
  const [followPending, setFollowPending] = React.useState(false)

  React.useEffect(() => {
    if (!username) return

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets loading/error state when username param changes
    setLoading(true)
    setError(null)

    Promise.all([
      getPublicUser(username),
      getCurrentUser().catch(() => null),
    ])
      .then(([data, own]) => {
        if (cancelled) return
        setProfile(data)
        setOwnUsername(own?.username ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(
          err instanceof ApiError && err.status === 404
            ? "This user doesn't exist."
            : "Unable to load this profile."
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [username])

  const isOwnProfile = profile !== null && ownUsername === profile.username

  const profileUsername = profile?.username
  const fetchProfilePosts = React.useCallback(
    (cursor: string | undefined) => {
      if (!profileUsername) throw new Error("Profile not loaded yet")
      return getPostsByUser(profileUsername, cursor)
    },
    [profileUsername]
  )

  React.useEffect(() => {
    if (!profile || isOwnProfile) return

    let cancelled = false
    getFollowStatus(profile.username)
      .then((state) => {
        if (!cancelled) setFollowState(state)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [profile, isOwnProfile])

  async function handleToggleFollow() {
    if (!profile) return

    setFollowPending(true)
    const wasFollowing = followState === "FOLLOWING"
    try {
      if (followState === "FOLLOWING" || followState === "PENDING") {
        await unfollowUser(profile.username)
        setFollowState("NOT_FOLLOWING")
        if (wasFollowing) {
          setProfile({ ...profile, followersCount: Math.max(0, profile.followersCount - 1) })
        }
      } else {
        const newState = await followUser(profile.username)
        setFollowState(newState)
        if (newState === "FOLLOWING") {
          setProfile({ ...profile, followersCount: profile.followersCount + 1 })
        }
      }
    } catch {
      // Leave state unchanged on network error
    } finally {
      setFollowPending(false)
    }
  }

  const rightSidebar = (
    <div className="flex flex-col gap-5 w-full">
      <SearchBar />
      <TrendingWidget />
    </div>
  )

  return (
    <AppLayout
      headerTitle={profile ? profile.displayName : "Profile"}
      rightSidebar={rightSidebar}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col border-x border-border/50 min-h-screen bg-card/20">
        {loading && (
          <div className="flex items-center justify-center py-24 gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading profile...</span>
          </div>
        )}

        {!loading && error && (
          <div className="p-4 sm:p-6">
            <Alert variant="destructive">{error}</Alert>
          </div>
        )}

        {!loading && profile && (
          <div className="flex flex-col w-full">
            {/* Cover Banner */}
            <div className="h-44 sm:h-56 w-full bg-gradient-to-r from-primary/20 via-primary/10 to-accent relative overflow-hidden">
              {profile.coverImageUrl ? (
                <img
                  src={profile.coverImageUrl}
                  alt="Cover"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 opacity-30 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/30 via-transparent to-transparent" />
              )}
            </div>

            {/* Profile Info Header */}
            <div className="px-4 sm:px-6 pb-5 flex flex-col gap-3.5 border-b border-border/50">
              {/* Avatar & Actions Row */}
              <div className="-mt-14 sm:-mt-16 flex items-end justify-between gap-3">
                <div className="relative">
                  <img
                    src={
                      profile.avatarUrl ??
                      `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(profile.username)}`
                    }
                    alt={profile.displayName}
                    className="size-24 sm:size-28 rounded-full ring-4 ring-background object-cover bg-card shadow-md"
                  />
                </div>

                <div className="flex items-center gap-2">
                  {isOwnProfile ? (
                    <Button variant="outline" size="sm" asChild className="rounded-full gap-1.5 shadow-none text-xs font-semibold px-4">
                      <Link to="/settings">
                        <Edit3 className="size-3.5" />
                        <span>Edit profile</span>
                      </Link>
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" asChild className="rounded-full gap-1.5 shadow-none text-xs font-semibold px-3.5">
                        <Link to={`/messages?with=${encodeURIComponent(profile.username)}`}>
                          <MessageSquare className="size-3.5" />
                          <span>Message</span>
                        </Link>
                      </Button>
                      <Button
                        variant={followState === "NOT_FOLLOWING" ? "default" : "outline"}
                        size="sm"
                        disabled={followPending}
                        onClick={handleToggleFollow}
                        className="rounded-full min-w-24 font-semibold text-xs shadow-none cursor-pointer"
                      >
                        {followPending && <Loader2 className="size-3 animate-spin mr-1.5" />}
                        {followState === "FOLLOWING" && "Unfollow"}
                        {followState === "PENDING" && "Requested"}
                        {followState === "NOT_FOLLOWING" && "Follow"}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Name & Handle */}
              <div className="flex flex-col gap-0.5 pt-1">
                <div className="flex items-center gap-1.5">
                  <h1 className="text-xl font-bold text-foreground tracking-tight">
                    {profile.displayName}
                  </h1>
                  {profile.verified && (
                    <span
                      className="inline-flex items-center justify-center size-4 rounded-full bg-primary text-primary-foreground"
                      title="Verified user"
                      aria-label="Verified"
                    >
                      <Check className="size-2.5 stroke-[3]" />
                    </span>
                  )}
                  {profile.privateAccount && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
                      <Lock className="size-2.5" />
                      Private
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-medium">@{profile.username}</p>
              </div>

              {/* Bio */}
              {profile.bio && (
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {profile.bio}
                </p>
              )}

              {/* Metadata Row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                {profile.location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-3.5 text-muted-foreground shrink-0" />
                    <span>{profile.location}</span>
                  </span>
                )}
                {profile.websiteUrl && (
                  <a
                    href={profile.websiteUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 text-primary hover:underline"
                  >
                    <LinkIcon className="size-3.5 shrink-0" />
                    <span>{profile.websiteUrl.replace(/^https?:\/\//, "")}</span>
                  </a>
                )}
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-3.5 shrink-0" />
                  <span>Joined {formatJoinDate(profile.createdAt)}</span>
                </span>
              </div>

              {/* Metrics Stats */}
              <div className="flex items-center gap-6 pt-2 border-t border-border/40 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="font-bold text-foreground text-sm">{profile.postsCount}</span>
                  <span className="text-muted-foreground">Posts</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="font-bold text-foreground text-sm">{profile.followersCount}</span>
                  <span className="text-muted-foreground">Followers</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="font-bold text-foreground text-sm">{profile.followingCount}</span>
                  <span className="text-muted-foreground">Following</span>
                </span>
              </div>
            </div>

            {/* Posts Tab Indicator */}
            <div className="flex items-center px-4 sm:px-6 border-b border-border/50">
              <div className="py-3 border-b-2 border-primary text-sm font-bold text-foreground px-2">
                Posts
              </div>
            </div>

            {/* Posts List */}
            <PostList
              key={profile.username}
              fetchPage={fetchProfilePosts}
              emptyMessage={`@${profile.username} hasn't posted anything yet.`}
              showInsights={isOwnProfile}
            />
          </div>
        )}
      </div>
    </AppLayout>
  )
}
