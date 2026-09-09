import * as React from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  User,
  Image as ImageIcon,
  MapPin,
  Globe,
  Calendar,
  Lock,
  Loader2,
  CheckCircle2,
  ExternalLink,
  Upload,
  AlertTriangle,
} from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { FollowRequestsCard } from "@/components/follow-requests-card"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { ApiError } from "@/lib/api"
import { uploadMedia, type UploadPurpose } from "@/lib/media"
import {
  deleteCurrentUser,
  getCurrentUser,
  updateCurrentUser,
  type UpdateProfilePayload,
  type UserProfile,
} from "@/lib/user"

type FormState = {
  username: string
  displayName: string
  bio: string
  avatarUrl: string
  coverImageUrl: string
  location: string
  websiteUrl: string
  birthdate: string
  privateAccount: boolean
}

function toFormState(profile: UserProfile): FormState {
  return {
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio ?? "",
    avatarUrl: profile.avatarUrl ?? "",
    coverImageUrl: profile.coverImageUrl ?? "",
    location: profile.location ?? "",
    websiteUrl: profile.websiteUrl ?? "",
    birthdate: profile.birthdate ?? "",
    privateAccount: profile.privateAccount,
  }
}

function toPayload(form: FormState): UpdateProfilePayload {
  const optional = (value: string) => (value.trim() === "" ? undefined : value.trim())

  return {
    username: form.username.trim(),
    displayName: form.displayName.trim(),
    bio: optional(form.bio),
    avatarUrl: optional(form.avatarUrl),
    coverImageUrl: optional(form.coverImageUrl),
    location: optional(form.location),
    websiteUrl: optional(form.websiteUrl),
    birthdate: optional(form.birthdate),
    privateAccount: form.privateAccount,
  }
}

export default function Settings() {
  const navigate = useNavigate()
  const { signOut } = useAuth()

  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [form, setForm] = React.useState<FormState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [saved, setSaved] = React.useState(false)

  const [uploading, setUploading] = React.useState<Record<"avatar" | "cover", boolean>>({
    avatar: false,
    cover: false,
  })
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const avatarFileInputRef = React.useRef<HTMLInputElement>(null)
  const coverFileInputRef = React.useRef<HTMLInputElement>(null)

  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false

    getCurrentUser()
      .then((data) => {
        if (cancelled) return
        setProfile(data)
        setForm(toFormState(data))
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(
          err instanceof ApiError ? err.message : "Unable to load your profile."
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
    setSaved(false)
  }

  async function handleImageSelected(kind: "avatar" | "cover", file: File | undefined) {
    if (!file) return

    setUploadError(null)
    setUploading((prev) => ({ ...prev, [kind]: true }))

    try {
      const purpose: UploadPurpose = kind === "avatar" ? "AVATAR" : "COVER"
      const publicUrl = await uploadMedia(file, purpose)
      updateField(kind === "avatar" ? "avatarUrl" : "coverImageUrl", publicUrl)
    } catch (err) {
      setUploadError(
        err instanceof ApiError ? err.message : `Unable to upload ${kind} image.`
      )
    } finally {
      setUploading((prev) => ({ ...prev, [kind]: false }))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return

    setSaveError(null)
    setFieldErrors({})
    setSaved(false)
    setSaving(true)

    try {
      const updated = await updateCurrentUser(toPayload(form))
      setProfile(updated)
      setForm(toFormState(updated))
      setSaved(true)
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err.message)
        setFieldErrors(err.fieldErrors ?? {})
      } else {
        setSaveError("Unable to save your profile.")
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount() {
    if (!profile || deleteConfirmText !== profile.username || deleting) return

    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteCurrentUser()
      await signOut()
      navigate("/login")
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Unable to delete your account.")
      setDeleting(false)
    }
  }

  return (
    <AppLayout
      headerTitle="Settings"
      headerAction={
        profile ? (
          <Button variant="outline" size="sm" asChild className="rounded-full text-xs font-semibold gap-1.5 shadow-none px-3.5">
            <Link to={`/profile/${profile.username}`}>
              <span>View Public Profile</span>
              <ExternalLink className="size-3" />
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        {loading && (
          <div className="flex items-center justify-center py-24 gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading your settings...</span>
          </div>
        )}

        {!loading && loadError && <Alert variant="destructive">{loadError}</Alert>}

        {!loading && form && profile && (
          <>
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            {saveError && <Alert variant="destructive">{saveError}</Alert>}
            {uploadError && <Alert variant="destructive">{uploadError}</Alert>}
            {saved && (
              <Alert variant="success" className="flex items-center gap-2">
                <CheckCircle2 className="size-4" />
                <span>Your profile changes have been saved successfully.</span>
              </Alert>
            )}

            {/* Profile Images Card */}
            <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
              <CardHeader className="p-5 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-primary/10 text-primary">
                    <ImageIcon className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold">Profile Images</CardTitle>
                    <CardDescription className="text-xs">
                      Update your avatar and cover banner
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-2 flex flex-col gap-4">
                {/* Live Banner Preview with Avatar */}
                <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-muted/20">
                  <div className="h-32 w-full bg-gradient-to-r from-primary/20 via-primary/10 to-accent relative overflow-hidden">
                    {form.coverImageUrl ? (
                      <img
                        src={form.coverImageUrl}
                        alt="Cover preview"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/60">
                        No cover image set
                      </div>
                    )}
                  </div>
                  <div className="px-4 pb-4 flex items-end justify-between">
                    <div className="-mt-10 relative">
                      <img
                        src={
                          form.avatarUrl ||
                          `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(form.username)}`
                        }
                        alt="Avatar preview"
                        className="size-20 rounded-full ring-4 ring-background object-cover bg-card shadow-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  {/* Avatar Upload Field */}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="avatarUrl" className="text-xs font-semibold">Avatar Image URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="avatarUrl"
                        type="url"
                        placeholder="https://..."
                        value={form.avatarUrl}
                        aria-invalid={Boolean(fieldErrors.avatarUrl)}
                        onChange={(e) => updateField("avatarUrl", e.target.value)}
                        className="text-xs h-9.5 rounded-full bg-muted/40 border-border/50"
                      />
                      <input
                        ref={avatarFileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleImageSelected("avatar", e.target.files?.[0])}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploading.avatar}
                        onClick={() => avatarFileInputRef.current?.click()}
                        className="rounded-full shrink-0 text-xs h-9.5 px-3.5 cursor-pointer shadow-none"
                      >
                        {uploading.avatar ? (
                          <Loader2 className="size-3 animate-spin mr-1" />
                        ) : (
                          <Upload className="size-3 mr-1" />
                        )}
                        <span>Upload</span>
                      </Button>
                    </div>
                    {fieldErrors.avatarUrl && (
                      <p className="text-xs text-destructive">{fieldErrors.avatarUrl}</p>
                    )}
                  </div>

                  {/* Cover Upload Field */}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="coverImageUrl" className="text-xs font-semibold">Cover Image URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="coverImageUrl"
                        type="url"
                        placeholder="https://..."
                        value={form.coverImageUrl}
                        aria-invalid={Boolean(fieldErrors.coverImageUrl)}
                        onChange={(e) => updateField("coverImageUrl", e.target.value)}
                        className="text-xs h-9.5 rounded-full bg-muted/40 border-border/50"
                      />
                      <input
                        ref={coverFileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleImageSelected("cover", e.target.files?.[0])}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploading.cover}
                        onClick={() => coverFileInputRef.current?.click()}
                        className="rounded-full shrink-0 text-xs h-9.5 px-3.5 cursor-pointer shadow-none"
                      >
                        {uploading.cover ? (
                          <Loader2 className="size-3 animate-spin mr-1" />
                        ) : (
                          <Upload className="size-3 mr-1" />
                        )}
                        <span>Upload</span>
                      </Button>
                    </div>
                    {fieldErrors.coverImageUrl && (
                      <p className="text-xs text-destructive">{fieldErrors.coverImageUrl}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Account Identity */}
            <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
              <CardHeader className="p-5 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-primary/10 text-primary">
                    <User className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold">Account Identity</CardTitle>
                    <CardDescription className="text-xs">
                      Your public handle, display name, and bio
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-2 flex flex-col gap-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="username" className="text-xs font-semibold">Username</Label>
                    <Input
                      id="username"
                      required
                      value={form.username}
                      aria-invalid={Boolean(fieldErrors.username)}
                      onChange={(e) => updateField("username", e.target.value)}
                      className="rounded-full text-xs h-9.5 bg-muted/40 border-border/50"
                    />
                    {fieldErrors.username && (
                      <p className="text-xs text-destructive">{fieldErrors.username}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="displayName" className="text-xs font-semibold">Display Name</Label>
                    <Input
                      id="displayName"
                      required
                      value={form.displayName}
                      aria-invalid={Boolean(fieldErrors.displayName)}
                      onChange={(e) => updateField("displayName", e.target.value)}
                      className="rounded-full text-xs h-9.5 bg-muted/40 border-border/50"
                    />
                    {fieldErrors.displayName && (
                      <p className="text-xs text-destructive">{fieldErrors.displayName}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="bio" className="text-xs font-semibold">Bio</Label>
                    <span className="text-[11px] text-muted-foreground">
                      {form.bio.length}/160
                    </span>
                  </div>
                  <Textarea
                    id="bio"
                    maxLength={160}
                    rows={3}
                    placeholder="Tell the community about yourself..."
                    value={form.bio}
                    aria-invalid={Boolean(fieldErrors.bio)}
                    onChange={(e) => updateField("bio", e.target.value)}
                    className="rounded-2xl text-xs resize-none bg-muted/40 border-border/50"
                  />
                  {fieldErrors.bio && <p className="text-xs text-destructive">{fieldErrors.bio}</p>}
                </div>
              </CardContent>
            </Card>

            {/* Personal Details */}
            <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
              <CardHeader className="p-5 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-primary/10 text-primary">
                    <Globe className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold">Personal Details</CardTitle>
                    <CardDescription className="text-xs">
                      Location, website link, and birthday
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-2 flex flex-col gap-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="location" className="text-xs font-semibold flex items-center gap-1.5">
                      <MapPin className="size-3 text-muted-foreground" />
                      Location
                    </Label>
                    <Input
                      id="location"
                      placeholder="e.g. San Francisco, CA"
                      value={form.location}
                      aria-invalid={Boolean(fieldErrors.location)}
                      onChange={(e) => updateField("location", e.target.value)}
                      className="rounded-full text-xs h-9.5 bg-muted/40 border-border/50"
                    />
                    {fieldErrors.location && (
                      <p className="text-xs text-destructive">{fieldErrors.location}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="websiteUrl" className="text-xs font-semibold flex items-center gap-1.5">
                      <Globe className="size-3 text-muted-foreground" />
                      Website
                    </Label>
                    <Input
                      id="websiteUrl"
                      type="url"
                      placeholder="https://yourwebsite.com"
                      value={form.websiteUrl}
                      aria-invalid={Boolean(fieldErrors.websiteUrl)}
                      onChange={(e) => updateField("websiteUrl", e.target.value)}
                      className="rounded-full text-xs h-9.5 bg-muted/40 border-border/50"
                    />
                    {fieldErrors.websiteUrl && (
                      <p className="text-xs text-destructive">{fieldErrors.websiteUrl}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5 max-w-sm">
                  <Label htmlFor="birthdate" className="text-xs font-semibold flex items-center gap-1.5">
                    <Calendar className="size-3 text-muted-foreground" />
                    Birthdate
                  </Label>
                  <Input
                    id="birthdate"
                    type="date"
                    value={form.birthdate}
                    aria-invalid={Boolean(fieldErrors.birthdate)}
                    onChange={(e) => updateField("birthdate", e.target.value)}
                    className="rounded-full text-xs h-9.5 bg-muted/40 border-border/50"
                  />
                  {fieldErrors.birthdate && (
                    <p className="text-xs text-destructive">{fieldErrors.birthdate}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Follow Requests */}
            {profile.privateAccount && <FollowRequestsCard />}

            {/* Privacy Section */}
            <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
              <CardHeader className="p-5 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-primary/10 text-primary">
                    <Lock className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold">Account Privacy</CardTitle>
                    <CardDescription className="text-xs">
                      Control who can follow you and view your posts
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-2">
                <label
                  htmlFor="privateAccount"
                  className="flex items-start gap-3.5 p-4 rounded-2xl bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors cursor-pointer select-none"
                >
                  <input
                    id="privateAccount"
                    type="checkbox"
                    checked={form.privateAccount}
                    onChange={(e) => updateField("privateAccount", e.target.checked)}
                    className="size-4.5 rounded border-input text-primary accent-primary focus:ring-primary mt-0.5 cursor-pointer"
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-foreground">
                      Private Account
                    </span>
                    <span className="text-[11px] text-muted-foreground leading-relaxed">
                      When enabled, new followers must be approved by you, and your follower and following lists are hidden from people who don&apos;t follow you.
                    </span>
                  </div>
                </label>
              </CardContent>
            </Card>

            {/* Save Button */}
            <div className="flex justify-end pb-4">
              <Button
                type="submit"
                size="lg"
                disabled={saving}
                className="w-full sm:w-auto px-8 rounded-full font-bold shadow-sm cursor-pointer h-10"
              >
                {saving && <Loader2 className="size-4 animate-spin mr-2" />}
                {saving ? "Saving Changes..." : "Save Changes"}
              </Button>
            </div>
          </form>

          {/* Danger Zone */}
          <Card className="rounded-3xl border-destructive/30 bg-card/40 overflow-hidden shadow-none">
            <CardHeader className="p-5 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-destructive/10 text-destructive">
                  <AlertTriangle className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-destructive">Danger Zone</CardTitle>
                  <CardDescription className="text-xs">
                    Permanently delete your account and all associated data
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-5 pt-2 flex flex-col gap-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Deleting your account removes your posts and comments from view and unfollows
                everyone in both directions. This cannot be undone.
              </p>

              {deleteError && <Alert variant="destructive">{deleteError}</Alert>}

              {!deleteConfirmOpen ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="w-full sm:w-auto rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer h-9 text-xs font-semibold px-4"
                >
                  Delete My Account
                </Button>
              ) : (
                <div className="flex flex-col gap-3 rounded-2xl bg-destructive/5 border border-destructive/20 p-4 animate-in fade-in-50">
                  <Label htmlFor="deleteConfirm" className="text-xs font-semibold">
                    Type <span className="font-mono font-bold">{profile.username}</span> to confirm
                  </Label>
                  <Input
                    id="deleteConfirm"
                    autoFocus
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={profile.username}
                    className="rounded-full text-xs h-9.5 bg-background border-border/60"
                  />
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteConfirmOpen(false)
                        setDeleteConfirmText("")
                        setDeleteError(null)
                      }}
                      disabled={deleting}
                      className="text-xs text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deleteConfirmText !== profile.username || deleting}
                      onClick={() => void handleDeleteAccount()}
                      className="rounded-full px-4 h-9 text-xs font-semibold cursor-pointer"
                    >
                      {deleting && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                      {deleting ? "Deleting..." : "Permanently Delete Account"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          </>
        )}
      </div>
    </AppLayout>
  )
}
