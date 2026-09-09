import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import Settings from "@/pages/Settings"
import * as userLib from "@/lib/user"
import type { UserProfile } from "@/lib/user"

const navigateMock = vi.fn()
const signOutMock = vi.fn().mockResolvedValue(undefined)

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ signOut: signOutMock }),
}))

vi.mock("@/lib/user", async () => {
  const actual = await vi.importActual<typeof import("@/lib/user")>("@/lib/user")
  return { ...actual, deleteCurrentUser: vi.fn(), updateCurrentUser: vi.fn() }
})

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: "user-1",
    username: "alice",
    email: "alice@example.com",
    displayName: "Alice",
    bio: null,
    avatarUrl: null,
    coverImageUrl: null,
    location: null,
    websiteUrl: null,
    birthdate: null,
    verified: false,
    privateAccount: false,
    status: "ACTIVE",
    followersCount: 0,
    followingCount: 0,
    postsCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  )
}

describe("Settings danger zone", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(userLib, "getCurrentUser").mockResolvedValue(makeProfile())
  })

  it("keeps the delete button disabled until the exact username is typed", async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole("button", { name: /delete my account/i }))

    const confirmButton = screen.getByRole("button", { name: /permanently delete account/i })
    expect(confirmButton).toBeDisabled()

    const input = screen.getByLabelText(/type/i)
    await user.type(input, "not-alice")
    expect(confirmButton).toBeDisabled()

    await user.clear(input)
    await user.type(input, "alice")
    expect(confirmButton).toBeEnabled()
  })

  it("deletes the account, signs out, and redirects to login on success", async () => {
    vi.mocked(userLib.deleteCurrentUser).mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole("button", { name: /delete my account/i }))
    await user.type(screen.getByLabelText(/type/i), "alice")
    await user.click(screen.getByRole("button", { name: /permanently delete account/i }))

    await waitFor(() => expect(userLib.deleteCurrentUser).toHaveBeenCalledTimes(1))
    expect(signOutMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith("/login")
  })

  it("shows an error and does not sign out if deletion fails", async () => {
    vi.mocked(userLib.deleteCurrentUser).mockRejectedValue(new Error("network error"))
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole("button", { name: /delete my account/i }))
    await user.type(screen.getByLabelText(/type/i), "alice")
    await user.click(screen.getByRole("button", { name: /permanently delete account/i }))

    await waitFor(() => expect(userLib.deleteCurrentUser).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/unable to delete your account/i)).toBeInTheDocument()
    expect(signOutMock).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
