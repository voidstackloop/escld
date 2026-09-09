import * as React from "react"
import { Sparkles } from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { CreatePostForm } from "@/components/create-post-form"
import { PostCard } from "@/components/post-card"
import { PostList } from "@/components/post-list"
import { SearchBar } from "@/components/search-bar"
import { TrendingWidget } from "@/components/trending-widget"
import { getFeed } from "@/lib/feed"
import type { Post } from "@/lib/post"

export default function Home() {
  const [justPosted, setJustPosted] = React.useState<Post[]>([])
  const composeRef = React.useRef<HTMLDivElement>(null)

  const handleScrollToCompose = () => {
    composeRef.current?.scrollIntoView({ behavior: "smooth" })
    const textarea = composeRef.current?.querySelector("textarea")
    textarea?.focus()
  }

  const rightSidebar = (
    <div className="flex flex-col gap-5 w-full">
      <SearchBar />
      <TrendingWidget />
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 px-3 text-[11px] text-muted-foreground/70">
        <span>&copy; {new Date().getFullYear()} escld</span>
        <a href="#privacy" className="hover:underline hover:text-foreground transition-colors">Privacy</a>
        <a href="#terms" className="hover:underline hover:text-foreground transition-colors">Terms</a>
        <a href="#status" className="hover:underline hover:text-foreground transition-colors">System Status</a>
      </div>
    </div>
  )

  return (
    <AppLayout
      headerTitle="Home"
      headerAction={
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          <span>Latest Feed</span>
        </div>
      }
      rightSidebar={rightSidebar}
      onNewPostClick={handleScrollToCompose}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col border-x border-border/50 min-h-screen bg-card/20">
        {/* On mobile and tablet without right sidebar, show SearchBar at top */}
        <div className="xl:hidden w-full p-4 border-b border-border/50">
          <SearchBar />
        </div>

        {/* Composer Card */}
        <div ref={composeRef} className="border-b border-border/50">
          <CreatePostForm onCreated={(post) => setJustPosted((prev) => [post, ...prev])} />
        </div>

        {/* Optimistically prepended posts */}
        {justPosted.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}

        {/* Paginated Feed */}
        <PostList
          fetchPage={getFeed}
          emptyMessage="Follow people to see their posts here in your personal feed."
        />
      </div>
    </AppLayout>
  )
}
