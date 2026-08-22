---
name: cowart-image-gen
display_name: Cowart Image Generation
description: >
  Generate and place AI images into the Cowart canvas
  when the user asks to create or fill an image holder.
version: 0.1.2
category: ai_media
tags:
  - creation
  - canvas
  - image
homepage: https://github.com/zhongerxin/cowart
---

# Cowart Image Generation

Use this skill when the user asks to generate an image for the current Cowart canvas.

## Workflow

1. Confirm the Cowart canvas service is running for the active project.
2. Prefer a selected Cowart AI image holder when one exists.
3. Generate or place the output into the canvas without moving unrelated user content.

AI image generation provider behavior is outside the first TabTin acceptance scope; this skill is declared so Cowart capabilities are visible after official plugin enablement.
