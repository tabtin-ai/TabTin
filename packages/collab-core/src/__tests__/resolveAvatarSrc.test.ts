import { describe, expect, it } from "vitest";
import { resolveAvatarSrc } from "../utils/resolveAvatarSrc.js";

describe("resolveAvatarSrc", () => {
  it("keeps absolute urls", () => {
    expect(resolveAvatarSrc("https://assets.example.com/a.png")).toBe(
      "https://assets.example.com/a.png",
    );
  });

  it("maps user-avatars object keys to assets CDN", () => {
    expect(resolveAvatarSrc("user-avatars/042a.png")).toBe(
      "https://assets.example.com/user-avatars/042a.png",
    );
  });

  it("returns null for empty and unknown relative paths", () => {
    expect(resolveAvatarSrc(null)).toBeNull();
    expect(resolveAvatarSrc("")).toBeNull();
    expect(resolveAvatarSrc("junk.png")).toBeNull();
  });
});
