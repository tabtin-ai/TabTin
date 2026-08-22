---
name: cowart-open-canvas
display_name: Cowart Open Canvas
description: >
  Open and use the Cowart local infinite canvas for
  the active TabTin project.
version: 0.1.2
category: media
tags:
  - creation
  - canvas
  - visual-thinking
homepage: https://github.com/zhongerxin/cowart
---

# Cowart Open Canvas

Use this skill when the user asks to open, launch, view, or work in a Cowart canvas.

## Workflow

1. Start the bundled Cowart prepared runtime for the active project workspace.
2. Open the resulting local URL for the user when browser control is available.
3. If browser control is not available, return the local URL and keep the service running.

The first official TabTin release installs Cowart as a prepared runtime. Do not ask the user to run `npm install` or `pnpm install` for Cowart.
