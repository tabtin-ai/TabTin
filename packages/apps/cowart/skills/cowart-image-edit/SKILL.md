---
name: cowart-image-edit
display_name: Cowart Image Edit
description: >
  Edit and revise Cowart canvas images: read user-provided
  annotation screenshots as edit briefs and produce
  revised images.
version: 0.1.2
category: ai_media
tags:
  - creation
  - canvas
  - image-edit
homepage: https://github.com/zhongerxin/cowart
---

# Cowart Image Edit

Use this skill when the user provides Cowart annotation screenshots and asks for revised images.

## Workflow

1. Treat the screenshot as the authoritative edit brief.
2. Extract visible annotation labels, arrows, and edit notes from the screenshot.
3. Create a revised image and place it near the original canvas content without deleting or hiding the original.

Do not scan the whole canvas to infer edit intent. Ask for a clearer screenshot or source image when the provided image is too cropped or low resolution.
